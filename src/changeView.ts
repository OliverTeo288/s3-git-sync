import { App, Modal, Notice, TFile } from "obsidian";
import type { LocalDB } from "./localdb";
import { SSOSessionExpiredError, type S3ClientWrapper } from "./s3client";
import { type ProgressCallback, executeSync } from "./syncEngine";
import type { FileChange, S3GitSyncSettings, SyncHistoryEntry, SyncStats } from "./types";
import type { Vault } from "obsidian";
import { computeChanges, groupChanges } from "./differ";

// ─── Diff helpers ─────────────────────────────────────────────────────────────

type DiffLine =
  | { type: "added" | "removed" | "context"; text: string }
  | { type: "separator" };

const TEXT_EXTS = new Set([
  "md", "txt", "json", "canvas", "excalidraw", "csv",
  "js", "ts", "jsx", "tsx", "html", "css", "scss",
  "yaml", "yml", "toml", "sh", "bash", "py", "go",
  "java", "c", "cpp", "h", "rs", "xml", "svg",
]);

function isTextFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTS.has(ext);
}

function computeDiff(aText: string, bText: string): DiffLine[] {
  const aLines = aText.split("\n");
  const bLines = bText.split("\n");
  const m = aLines.length, n = bLines.length;

  if (m > 600 || n > 600) return [{ type: "separator" }];

  // LCS DP table (Uint16Array saves memory; values ≤ 600 fit safely)
  const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = aLines[i - 1] === bLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to produce edit list
  const edits: Array<{ op: "=" | "+" | "-"; text: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      edits.unshift({ op: "=", text: aLines[i - 1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      edits.unshift({ op: "+", text: bLines[j - 1] }); j--;
    } else {
      edits.unshift({ op: "-", text: aLines[i - 1] }); i--;
    }
  }

  // Drop trailing empty "same" line (artefact of split on final newline)
  while (edits.length > 0 && edits[edits.length - 1].op === "=" && edits[edits.length - 1].text === "") {
    edits.pop();
  }

  const CONTEXT = 3;
  const len = edits.length;
  const include = new Uint8Array(len);

  for (let k = 0; k < len; k++) {
    if (edits[k].op !== "=") {
      const lo = Math.max(0, k - CONTEXT);
      const hi = Math.min(len - 1, k + CONTEXT);
      for (let d = lo; d <= hi; d++) include[d] = 1;
    }
  }

  const result: DiffLine[] = [];
  for (let k = 0; k < len; k++) {
    if (!include[k]) continue;
    if (k > 0 && !include[k - 1]) result.push({ type: "separator" });
    const { op, text } = edits[k];
    result.push(
      op === "=" ? { type: "context", text }
        : op === "+" ? { type: "added", text }
        : { type: "removed", text }
    );
  }
  return result;
}

// ─── File type badge ──────────────────────────────────────────────────────────

const EXT_LABELS: Record<string, string> = {
  md: "MD", txt: "TXT", pdf: "PDF", png: "PNG", jpg: "JPG", jpeg: "JPG",
  gif: "GIF", svg: "SVG", webp: "IMG", mp3: "MP3", mp4: "MP4", wav: "WAV",
  webm: "VID", json: "JSON", canvas: "CANVAS", css: "CSS", html: "HTML",
  js: "JS", ts: "TS", excalidraw: "DRAW", csv: "CSV", zip: "ZIP",
};

function fileTypeBadge(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LABELS[ext] ?? (ext.toUpperCase().slice(0, 5) || "FILE");
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatSize(bytes: number | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatAge(mtime: number | Date | undefined): string {
  if (!mtime) return "";
  const ms = mtime instanceof Date ? mtime.getTime() : mtime;
  const delta = Date.now() - ms;
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Returns the deepest 2 folder segments of a path, prefixed with `…/`
 * if there are more above. Keeps the most informative part visible
 * even on narrow modals — the immediate parent folder is what users
 * actually look at to disambiguate "Notes/foo.md" from "Archive/foo.md".
 */
function shortenDir(parts: string[]): string {
  const dirs = parts.slice(0, -1);
  if (dirs.length === 0) return "";
  if (dirs.length <= 2) return dirs.join("/") + "/";
  return "…/" + dirs.slice(-2).join("/") + "/";
}

/**
 * Open the given vault path in a new tab if it exists locally. Returns
 * `true` on success — used by the change-view rows to gate the click affordance
 * (remote-only files have no local TFile yet and aren't clickable).
 */
async function openInVault(app: App, key: string): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(key);
  if (!(file instanceof TFile)) return false;
  await app.workspace.getLeaf("tab").openFile(file);
  return true;
}

/** Add a click handler that opens `key` in Obsidian, plus a clickable affordance class. */
function makePathClickable(el: HTMLElement, app: App, key: string): void {
  if (!(app.vault.getAbstractFileByPath(key) instanceof TFile)) return;
  el.addClass("s3sync-file-clickable");
  el.title = `${key}\n\nClick to open`;
  el.onclick = async (e) => {
    e.stopPropagation();
    const opened = await openInVault(app, key);
    if (!opened) new Notice("File no longer exists in vault.", 3000);
  };
}

// ─── Change Preview Modal ─────────────────────────────────────────────────────

export class ChangeViewModal extends Modal {
  private changes: FileChange[] = [];
  private readonly vault: Vault;
  private readonly s3: S3ClientWrapper;
  private readonly db: LocalDB;
  private readonly settings: S3GitSyncSettings;

  /** Tracks which files are checked (default: all checked) */
  private checkedKeys = new Set<string>();
  /** Per-conflict resolution overrides */
  private conflictResolutions = new Map<string, "local" | "remote">();

  private messageInput: HTMLInputElement | null = null;
  private syncBtn: HTMLButtonElement | null = null;
  private progressEl: HTMLElement | null = null;

  constructor(
    app: App,
    vault: Vault,
    s3: S3ClientWrapper,
    db: LocalDB,
    settings: S3GitSyncSettings
  ) {
    super(app);
    this.vault = vault;
    this.s3 = s3;
    this.db = db;
    this.settings = settings;
  }

  async onOpen() {
    await this.loadChanges();
  }

  onClose() {
    this.contentEl.empty();
  }

  private async loadChanges() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("s3sync-modal");
    contentEl.createDiv({ cls: "s3sync-loading", text: "Computing changes…" });

    try {
      const { changes } = await computeChanges(this.vault, this.s3, this.db, this.settings);
      this.changes = changes;
      // Reset selection state
      this.checkedKeys = new Set(changes.map((c) => c.key));
      this.conflictResolutions = new Map(
        changes.filter((c) => c.changeType === "conflict").map((c) => [c.key, "local" as const])
      );
      contentEl.empty();
      this.render(contentEl);
    } catch (err: unknown) {
      contentEl.empty();
      const banner = contentEl.createDiv({ cls: "s3sync-error-banner" });
      if (err instanceof SSOSessionExpiredError) {
        banner.createEl("strong", { text: "AWS SSO session expired" });
        banner.createEl("p", {
          text: "Run this in a terminal, then click Retry:",
        });
        banner.createEl("code", {
          cls: "s3sync-error-cmd",
          text: `aws sso login --profile ${err.profileName}`,
        });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        banner.setText(`Failed to compute changes: ${msg}`);
      }
      const retryBtn = contentEl.createEl("button", { cls: "mod-cta s3sync-retry-btn", text: "Retry" });
      retryBtn.onclick = () => this.loadChanges();
    }
  }

  private render(root: HTMLElement) {
    const grouped = groupChanges(this.changes);
    const totalChanges = this.changes.length;

    // ── Header ────────────────────────────────────────────────────────────────
    const header = root.createDiv("s3sync-header");
    header.createEl("h2", { text: "S3 changes" });

    const stats = header.createDiv("s3sync-stats-row");
    if (grouped.localNew.length + grouped.localModified.length > 0) {
      stats.createSpan({ cls: "s3sync-badge s3sync-badge-upload", text: `↑ ${grouped.localNew.length + grouped.localModified.length} upload` });
    }
    if (grouped.remoteNew.length + grouped.remoteModified.length > 0) {
      stats.createSpan({ cls: "s3sync-badge s3sync-badge-download", text: `↓ ${grouped.remoteNew.length + grouped.remoteModified.length} download` });
    }
    if (grouped.localDeleted.length + grouped.remoteDeleted.length > 0) {
      stats.createSpan({ cls: "s3sync-badge s3sync-badge-delete", text: `✕ ${grouped.localDeleted.length + grouped.remoteDeleted.length} delete` });
    }
    if (grouped.conflicts.length > 0) {
      stats.createSpan({ cls: "s3sync-badge s3sync-badge-conflict", text: `⚠ ${grouped.conflicts.length} conflict` });
    }

    if (totalChanges === 0) {
      root.createDiv({ cls: "s3sync-empty", text: "Everything is up to date. Nothing to sync." });
      root.createDiv("s3sync-footer").createEl("button", {
        cls: "mod-cta",
        text: "Close",
      }).onclick = () => this.close();
      return;
    }

    // ── File sections ─────────────────────────────────────────────────────────
    const body = root.createDiv("s3sync-body");

    if (grouped.localNew.length > 0) {
      this.renderSection(body, "📤 Upload to S3 — New files", grouped.localNew, "upload");
    }
    if (grouped.localModified.length > 0) {
      this.renderSection(body, "📤 Upload to S3 — Modified files", grouped.localModified, "upload");
    }
    if (grouped.remoteNew.length > 0) {
      this.renderSection(body, "📥 Download from S3 — New files", grouped.remoteNew, "download");
    }
    if (grouped.remoteModified.length > 0) {
      this.renderSection(body, "📥 Download from S3 — Modified files", grouped.remoteModified, "download");
    }
    if (grouped.localDeleted.length > 0) {
      this.renderSection(body, "🗑️ Delete from S3 (removed locally)", grouped.localDeleted, "delete-s3");
    }
    if (grouped.remoteDeleted.length > 0) {
      this.renderSection(body, "🗑️ Delete locally (removed from S3)", grouped.remoteDeleted, "delete-local");
    }
    if (grouped.conflicts.length > 0) {
      this.renderConflictSection(body, grouped.conflicts);
    }

    // ── Commit message ────────────────────────────────────────────────────────
    const msgRow = root.createDiv("s3sync-message-row");
    msgRow.createEl("label", { text: "Sync message (optional):", attr: { for: "s3sync-msg" } });
    this.messageInput = msgRow.createEl("input", {
      type: "text",
      placeholder: "e.g. evening sync, chapter 3 edits…",
      attr: { id: "s3sync-msg" },
    });

    // ── Progress ──────────────────────────────────────────────────────────────
    this.progressEl = root.createDiv("s3sync-progress");
    this.progressEl.hide();

    // ── Footer buttons ────────────────────────────────────────────────────────
    const footer = root.createDiv("s3sync-footer");

    // Secondary row: utility actions
    const footerSecondary = footer.createDiv("s3sync-footer-secondary");

    const refreshBtn = footerSecondary.createEl("button", { text: "Refresh" });
    refreshBtn.title = "Re-scan for changes";
    refreshBtn.onclick = () => this.loadChanges();

    footerSecondary.createEl("button", { text: "Select all" }).onclick = () => {
      this.changes.forEach((c) => this.checkedKeys.add(c.key));
      root.querySelectorAll<HTMLInputElement>(".s3sync-file-checkbox").forEach((cb) => { cb.checked = true; });
      this.updateSyncButton();
    };

    footerSecondary.createEl("button", { text: "Deselect all" }).onclick = () => {
      this.checkedKeys.clear();
      root.querySelectorAll<HTMLInputElement>(".s3sync-file-checkbox").forEach((cb) => { cb.checked = false; });
      this.updateSyncButton();
    };

    // Primary row: Cancel + Sync
    const footerPrimary = footer.createDiv("s3sync-footer-primary");
    footerPrimary.createEl("button", { text: "Cancel" }).onclick = () => this.close();

    this.syncBtn = footerPrimary.createEl("button", {
      cls: "mod-cta",
      text: `Sync (${totalChanges})`,
    });
    this.syncBtn.onclick = () => this.doSync();
  }

  private renderSection(
    parent: HTMLElement,
    title: string,
    changes: FileChange[],
    colorClass: string
  ) {
    const section = parent.createDiv(`s3sync-section s3sync-section-${colorClass}`);
    section.createEl("h4", { text: title });

    for (const change of changes) {
      const row = section.createDiv("s3sync-file-row");

      const cb = row.createEl("input", { type: "checkbox", cls: "s3sync-file-checkbox" });
      cb.checked = this.checkedKeys.has(change.key);
      cb.onchange = () => {
        if (cb.checked) this.checkedKeys.add(change.key);
        else this.checkedKeys.delete(change.key);
        this.updateSyncButton();
      };

      const badge = change.changeType.includes("new") ? "NEW"
        : change.changeType.includes("modified") ? "MOD"
        : "DEL";
      row.createSpan({ cls: `s3sync-type-badge s3sync-type-${badge.toLowerCase()}`, text: badge });
      row.createSpan({ cls: "s3sync-ext-badge", text: fileTypeBadge(change.key) });

      const pathWrap = row.createDiv("s3sync-file-path-wrap");
      pathWrap.title = change.key;
      const parts = change.key.split("/");
      pathWrap.createSpan({ cls: "s3sync-file-name", text: parts[parts.length - 1] });
      const shortDir = shortenDir(parts);
      if (shortDir) {
        pathWrap.createSpan({ cls: "s3sync-file-dir", text: shortDir });
      }
      makePathClickable(pathWrap, this.app, change.key);

      const meta = row.createSpan({ cls: "s3sync-file-meta" });
      if (change.localMtime || change.remoteMtime) {
        const mtime = change.changeType.startsWith("local") ? change.localMtime : change.remoteMtime;
        meta.setText(formatAge(mtime));
      }
      if (change.localSize ?? change.remoteSize) {
        const size = change.changeType.startsWith("local") ? change.localSize : change.remoteSize;
        meta.setText(`${meta.getText()}  ${formatSize(size)}`.trim());
      }

      // Diff toggle — only for modified text files (both sides exist to compare)
      const canDiff = isTextFile(change.key) && (
        change.changeType === "local_modified" ||
        change.changeType === "remote_modified"
      );
      if (canDiff) {
        const panel = section.createDiv("s3sync-diff-panel");
        panel.hide();
        let loaded = false;

        const toggleBtn = row.createEl("button", { cls: "s3sync-diff-toggle", text: "▶ Diff" });
        toggleBtn.onclick = async (e) => {
          e.stopPropagation();
          if (!panel.isShown()) {
            panel.show();
            toggleBtn.setText("▼ diff");
            if (!loaded) { loaded = true; await this.loadAndRenderDiff(panel, change); }
          } else {
            panel.hide();
            toggleBtn.setText("▶ Diff");
          }
        };
      }

    }
  }

  private renderConflictSection(parent: HTMLElement, conflicts: FileChange[]) {
    const section = parent.createDiv("s3sync-section s3sync-section-conflict");
    section.createEl("h4", { text: "⚠️ conflicts — both sides changed" });
    section.createEl("p", {
      cls: "s3sync-conflict-hint",
      text: "Both sides changed since last sync. Choose which version to keep for each file.",
    });

    for (const change of conflicts) {
      const row = section.createDiv("s3sync-conflict-row");

      const cb = row.createEl("input", { type: "checkbox", cls: "s3sync-file-checkbox" });
      cb.checked = this.checkedKeys.has(change.key);
      cb.onchange = () => {
        if (cb.checked) this.checkedKeys.add(change.key);
        else this.checkedKeys.delete(change.key);
        this.updateSyncButton();
      };

      const info = row.createDiv("s3sync-conflict-info");
      const conflictHeader = info.createDiv("s3sync-conflict-header");
      conflictHeader.createSpan({ cls: "s3sync-ext-badge", text: fileTypeBadge(change.key) });
      const cPathWrap = conflictHeader.createDiv("s3sync-file-path-wrap");
      cPathWrap.title = change.key;
      const cParts = change.key.split("/");
      cPathWrap.createSpan({ cls: "s3sync-file-name", text: cParts[cParts.length - 1] });
      const shortCDir = shortenDir(cParts);
      if (shortCDir) {
        cPathWrap.createSpan({ cls: "s3sync-file-dir", text: shortCDir });
      }
      makePathClickable(cPathWrap, this.app, change.key);

      const meta = info.createDiv("s3sync-conflict-meta");
      meta.createSpan({ text: `Local: ${formatAge(change.localMtime)}  ${formatSize(change.localSize)}` });
      meta.createSpan({ text: `Remote: ${formatAge(change.remoteMtime)}  ${formatSize(change.remoteSize)}` });

      const controls = row.createDiv("s3sync-conflict-controls");
      const defaultRes = this.conflictResolutions.get(change.key) ?? "local";

      const localBtn = controls.createEl("button", {
        cls: `s3sync-conflict-btn ${defaultRes === "local" ? "active" : ""}`,
        text: "Keep local",
      });
      const remoteBtn = controls.createEl("button", {
        cls: `s3sync-conflict-btn ${defaultRes === "remote" ? "active" : ""}`,
        text: "Keep remote",
      });

      localBtn.onclick = () => {
        this.conflictResolutions.set(change.key, "local");
        localBtn.addClass("active");
        remoteBtn.removeClass("active");
      };
      remoteBtn.onclick = () => {
        this.conflictResolutions.set(change.key, "remote");
        remoteBtn.addClass("active");
        localBtn.removeClass("active");
      };

      if (isTextFile(change.key)) {
        const panel = section.createDiv("s3sync-diff-panel");
        panel.hide();
        let loaded = false;

        const toggleBtn = controls.createEl("button", { cls: "s3sync-diff-toggle", text: "▶ Diff" });
        toggleBtn.onclick = async (e) => {
          e.stopPropagation();
          if (!panel.isShown()) {
            panel.show();
            toggleBtn.setText("▼ diff");
            if (!loaded) { loaded = true; await this.loadAndRenderDiff(panel, change); }
          } else {
            panel.hide();
            toggleBtn.setText("▶ Diff");
          }
        };
      }

    }
  }

  private updateSyncButton() {
    if (!this.syncBtn) return;
    const n = this.checkedKeys.size;
    this.syncBtn.setText(`Sync (${n})`);
    this.syncBtn.disabled = n === 0;
  }

  private async loadAndRenderDiff(panel: HTMLElement, change: FileChange): Promise<void> {
    panel.empty();
    const loading = panel.createDiv({ cls: "s3sync-diff-loading", text: "Loading diff…" });

    try {
      let aText: string, bText: string, aLabel: string, bLabel: string;
      const decode = (buf: ArrayBuffer) => new TextDecoder("utf-8", { fatal: false }).decode(buf);

      if (change.changeType === "local_modified") {
        const [remoteData, localData] = await Promise.all([
          this.s3.getObject(change.s3Key),
          this.vault.adapter.readBinary(change.key),
        ]);
        aText = decode(remoteData);  bLabel = "Local (your edits)";
        bText = decode(localData);   aLabel = "S3 (current)";
      } else if (change.changeType === "remote_modified") {
        const [localData, remoteData] = await Promise.all([
          this.vault.adapter.readBinary(change.key),
          this.s3.getObject(change.s3Key),
        ]);
        aText = decode(localData);   aLabel = "Local (current)";
        bText = decode(remoteData);  bLabel = "S3 (incoming)";
      } else {
        // conflict
        const [localData, remoteData] = await Promise.all([
          this.vault.adapter.readBinary(change.key),
          this.s3.getObject(change.s3Key),
        ]);
        aText = decode(localData);   aLabel = "Local";
        bText = decode(remoteData);  bLabel = "Remote";
      }

      panel.empty();
      const diffLines = computeDiff(aText, bText);

      if (diffLines.length === 0) {
        panel.createDiv({ cls: "s3sync-diff-empty", text: "No text differences" });
        return;
      }

      const header = panel.createDiv("s3sync-diff-header");
      header.createSpan({ cls: "s3sync-diff-label-del", text: `− ${aLabel}` });
      header.createSpan({ cls: "s3sync-diff-label-add", text: `+ ${bLabel}` });

      const body = panel.createDiv("s3sync-diff-body");

      if (diffLines.length === 1 && diffLines[0].type === "separator") {
        body.createDiv({ cls: "s3sync-diff-empty", text: "File too large to diff inline (> 600 lines)" });
        return;
      }

      for (const line of diffLines) {
        if (line.type === "separator") {
          body.createDiv({ cls: "s3sync-diff-separator", text: "⋯" });
        } else {
          const el = body.createDiv({ cls: `s3sync-diff-line s3sync-diff-${line.type}` });
          el.createSpan({ cls: "s3sync-diff-prefix", text: line.type === "added" ? "+" : line.type === "removed" ? "−" : " " });
          el.createSpan({ cls: "s3sync-diff-text", text: line.text || " " });
        }
      }
    } catch (err: unknown) {
      loading.remove();
      const msg = err instanceof Error ? err.message : String(err);
      panel.createDiv({ cls: "s3sync-diff-error", text: `Failed to load diff: ${msg}` });
    }
  }

  private async doSync() {
    if (!this.syncBtn || !this.progressEl) return;
    this.syncBtn.disabled = true;
    this.progressEl.show();

    const onProgress: ProgressCallback = (done, total, file, action) => {
      if (!this.progressEl) return;
      this.progressEl.setText(`Syncing… ${done + 1}/${total}  ${action}  ${file}`);
    };

    try {
      const stats = await executeSync(
        this.changes,
        {
          selectedKeys: this.checkedKeys,
          conflictResolutions: this.conflictResolutions,
          message: this.messageInput?.value ?? "",
        },
        this.vault,
        this.s3,
        this.db,
        onProgress
      );
      this.showResult(stats);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`S3 sync error: ${msg}`, 8000);
      this.syncBtn.disabled = false;
    }
  }

  private showResult(stats: SyncStats) {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("s3sync-modal");

    contentEl.createEl("h2", { text: "Sync complete" });

    const summary = contentEl.createDiv("s3sync-result-summary");
    const add = (label: string, val: number, cls: string) => {
      if (val === 0) return;
      summary.createDiv({ cls: `s3sync-result-row ${cls}` }).setText(`${label}: ${val}`);
    };
    add("Uploaded", stats.uploaded, "s3sync-result-upload");
    add("Downloaded", stats.downloaded, "s3sync-result-download");
    add("Deleted from S3", stats.deletedFromS3, "s3sync-result-delete");
    add("Deleted locally", stats.deletedFromLocal, "s3sync-result-delete");
    add("Conflicts resolved", stats.conflicts, "s3sync-result-conflict");

    if (stats.errors.length > 0) {
      contentEl.createEl("h4", { text: "Errors" });
      const errList = contentEl.createEl("ul", { cls: "s3sync-error-list" });
      stats.errors.forEach((e) => errList.createEl("li", { text: e }));
    }

    contentEl.createEl("button", { cls: "mod-cta", text: "Close" }).onclick = () => this.close();
  }
}

// ─── Sync History Modal ────────────────────────────────────────────────────────

export class HistoryModal extends Modal {
  private db: LocalDB;

  constructor(app: App, db: LocalDB) {
    super(app);
    this.db = db;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("s3sync-modal");
    contentEl.createEl("h2", { text: "Sync history" });

    const entries = await this.db.getHistory(50);

    if (entries.length === 0) {
      contentEl.createDiv({ cls: "s3sync-empty", text: "No sync history yet." });
    } else {
      const list = contentEl.createDiv("s3sync-history-list");
      for (const entry of entries) {
        this.renderEntry(list, entry);
      }
    }

    contentEl.createEl("button", { cls: "mod-cta", text: "Close" }).onclick = () => this.close();
  }

  private renderEntry(parent: HTMLElement, entry: SyncHistoryEntry) {
    const row = parent.createDiv("s3sync-history-row");
    const time = new Date(entry.time).toLocaleString();
    const msg = entry.message ? ` — "${entry.message}"` : "";
    row.createEl("strong", { text: `${time}${msg}` });

    const { stats } = entry;
    const parts: string[] = [];
    if (stats.uploaded) parts.push(`↑ ${stats.uploaded}`);
    if (stats.downloaded) parts.push(`↓ ${stats.downloaded}`);
    if (stats.deletedFromS3) parts.push(`✕ ${stats.deletedFromS3} from S3`);
    if (stats.deletedFromLocal) parts.push(`✕ ${stats.deletedFromLocal} locally`);
    if (stats.conflicts) parts.push(`⚠ ${stats.conflicts} conflicts`);
    if (stats.errors.length) parts.push(`⛔ ${stats.errors.length} errors`);

    const statsRow = row.createDiv("s3sync-history-stats-row");
    statsRow.createSpan({ cls: "s3sync-history-stats", text: parts.join("  ") || "no changes" });

    if (entry.files && entry.files.length > 0) {
      const fileList = row.createDiv("s3sync-history-files");
      fileList.hide();

      const toggleBtn = statsRow.createEl("button", {
        cls: "s3sync-history-files-toggle",
        text: `▶ ${entry.files.length} files`,
      });
      toggleBtn.onclick = () => {
        if (fileList.isShown()) {
          fileList.hide();
          toggleBtn.setText(`▶ ${entry.files!.length} files`);
        } else {
          fileList.show();
          toggleBtn.setText(`▼ ${entry.files!.length} files`);
        }
      };

      const ACTION_SYMBOL: Record<string, string> = {
        uploaded: "↑", downloaded: "↓",
        "deleted-s3": "✕", "deleted-local": "✕", conflict: "⚠",
      };
      for (const f of entry.files) {
        const sym = ACTION_SYMBOL[f.action] ?? "·";
        fileList.createDiv({ cls: "s3sync-history-file", text: `${sym}  ${f.key}` });
      }
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
