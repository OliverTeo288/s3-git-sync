import { App, Modal, Notice } from "obsidian";
import type { Vault } from "obsidian";
import type { LocalDB } from "../sync/localdb";
import type { S3ClientWrapper } from "../s3/client";
import { type ProgressCallback, executeSync } from "../sync/engine";
import type { FileChange, S3GitSyncSettings, SyncStats } from "../types";
import { computeChanges, groupChanges } from "../sync/differ";
import { computeDiff, isTextFile } from "../sync/diffEngine";
import { fileTypeBadge, formatAge, formatSize, makePathClickable, renderErrorBanner, shortenDir } from "./uiHelpers";
import { FileVersionModal } from "./versionModals";
import { extractErrorMessage } from "../utils";

// ─── Barrel re-exports ────────────────────────────────────────────────────────

export { HistoryModal } from "./historyModal";
export { FileVersionModal, VersionPreviewModal } from "./versionModals";
export { BackupModal } from "./backupModal";

// ─── Change Preview Modal ─────────────────────────────────────────────────────

export class ChangeViewModal extends Modal {
  private changes: FileChange[] = [];
  private readonly vault: Vault;
  private readonly s3: S3ClientWrapper;
  private readonly db: LocalDB;
  private readonly settings: S3GitSyncSettings;
  private readonly onSyncComplete?: () => void;
  /** Lets the plugin hold its global isSyncing lock for the duration of a modal sync. */
  private readonly setSyncing?: (busy: boolean) => void;

  private checkedKeys = new Set<string>();
  private conflictResolutions = new Map<string, "local" | "remote">();
  private messageInput: HTMLInputElement | null = null;
  private syncBtn: HTMLButtonElement | null = null;
  private progressEl: HTMLElement | null = null;

  constructor(
    app: App,
    vault: Vault,
    s3: S3ClientWrapper,
    db: LocalDB,
    settings: S3GitSyncSettings,
    onSyncComplete?: () => void,
    setSyncing?: (busy: boolean) => void,
  ) {
    super(app);
    this.vault = vault;
    this.s3 = s3;
    this.db = db;
    this.settings = settings;
    this.onSyncComplete = onSyncComplete;
    this.setSyncing = setSyncing;
  }

  async onOpen() { await this.loadChanges(); }
  onClose() { this.contentEl.empty(); }

  private async loadChanges() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("s3sync-modal");
    contentEl.createDiv({ cls: "s3sync-loading", text: "Computing changes…" });

    try {
      const { changes } = await computeChanges(this.vault, this.s3, this.db, this.settings);
      this.changes = changes;
      this.checkedKeys = new Set(changes.map((c) => c.key));
      this.conflictResolutions = new Map(
        changes.filter((c) => c.changeType === "conflict").map((c) => [c.key, "local" as const])
      );
      contentEl.empty();
      this.render(contentEl);
    } catch (err: unknown) {
      contentEl.empty();
      renderErrorBanner(contentEl, err, "Failed to compute changes");
      contentEl.createEl("button", { cls: "mod-cta s3sync-retry-btn", text: "Retry" })
        .onclick = () => this.loadChanges();
    }
  }

  private render(root: HTMLElement) {
    const grouped = groupChanges(this.changes);
    const totalChanges = this.changes.length;

    this.renderHeader(root, grouped);

    if (totalChanges === 0) {
      root.createDiv({ cls: "s3sync-empty", text: "Everything is up to date. Nothing to sync." });
      root.createDiv("s3sync-footer").createEl("button", { cls: "mod-cta", text: "Close" })
        .onclick = () => this.close();
      return;
    }

    const body = root.createDiv("s3sync-body");
    if (grouped.localNew.length > 0)      this.renderSection(body, "📤 Upload to S3 — New files", grouped.localNew, "upload");
    if (grouped.localModified.length > 0) this.renderSection(body, "📤 Upload to S3 — Modified files", grouped.localModified, "upload");
    if (grouped.remoteNew.length > 0)     this.renderSection(body, "📥 Download from S3 — New files", grouped.remoteNew, "download");
    if (grouped.remoteModified.length > 0) this.renderSection(body, "📥 Download from S3 — Modified files", grouped.remoteModified, "download");
    if (grouped.localDeleted.length > 0)  this.renderSection(body, "🗑️ Delete from S3 (removed locally)", grouped.localDeleted, "delete-s3");
    if (grouped.remoteDeleted.length > 0) this.renderSection(body, "🗑️ Delete locally (removed from S3)", grouped.remoteDeleted, "delete-local");
    if (grouped.conflicts.length > 0)     this.renderConflictSection(body, grouped.conflicts);

    this.renderFooter(root, totalChanges);
  }

  private renderHeader(root: HTMLElement, grouped: ReturnType<typeof groupChanges>) {
    const header = root.createDiv("s3sync-header");
    header.createEl("h2", { text: "S3 changes" });
    const stats = header.createDiv("s3sync-stats-row");
    const uploads = grouped.localNew.length + grouped.localModified.length;
    const downloads = grouped.remoteNew.length + grouped.remoteModified.length;
    const deletes = grouped.localDeleted.length + grouped.remoteDeleted.length;
    if (uploads > 0)             stats.createSpan({ cls: "s3sync-badge s3sync-badge-upload",   text: `↑ ${uploads} upload` });
    if (downloads > 0)           stats.createSpan({ cls: "s3sync-badge s3sync-badge-download", text: `↓ ${downloads} download` });
    if (deletes > 0)             stats.createSpan({ cls: "s3sync-badge s3sync-badge-delete",   text: `✕ ${deletes} delete` });
    if (grouped.conflicts.length > 0) stats.createSpan({ cls: "s3sync-badge s3sync-badge-conflict", text: `⚠ ${grouped.conflicts.length} conflict` });
  }

  private renderFooter(root: HTMLElement, totalChanges: number) {
    const msgRow = root.createDiv("s3sync-message-row");
    msgRow.createEl("label", { text: "Sync message (optional):", attr: { for: "s3sync-msg" } });
    this.messageInput = msgRow.createEl("input", {
      type: "text", placeholder: "e.g. evening sync, chapter 3 edits…", attr: { id: "s3sync-msg" },
    });

    this.progressEl = root.createDiv("s3sync-progress");
    this.progressEl.hide();

    const footer = root.createDiv("s3sync-footer");
    const secondary = footer.createDiv("s3sync-footer-secondary");
    secondary.createEl("button", { text: "Refresh" }).onclick = () => this.loadChanges();
    secondary.createEl("button", { text: "Select all" }).onclick = () => {
      this.changes.forEach((c) => this.checkedKeys.add(c.key));
      root.querySelectorAll<HTMLInputElement>(".s3sync-file-checkbox").forEach((cb) => { cb.checked = true; });
      this.updateSyncButton();
    };
    secondary.createEl("button", { text: "Deselect all" }).onclick = () => {
      this.checkedKeys.clear();
      root.querySelectorAll<HTMLInputElement>(".s3sync-file-checkbox").forEach((cb) => { cb.checked = false; });
      this.updateSyncButton();
    };

    const primary = footer.createDiv("s3sync-footer-primary");
    primary.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    this.syncBtn = primary.createEl("button", { cls: "mod-cta", text: `Sync (${totalChanges})` });
    this.syncBtn.onclick = () => this.doSync();
  }

  private renderSection(parent: HTMLElement, title: string, changes: FileChange[], colorClass: string) {
    const section = parent.createDiv(`s3sync-section s3sync-section-${colorClass}`);
    section.createEl("h4", { text: title });
    for (const change of changes) {
      const row = this.renderFileRow(section, change);
      this.attachDiffToggle(section, row, change);
      if (change.changeType !== "local_new") {
        const versionsBtn = row.createEl("button", { cls: "s3sync-versions-btn", text: "⏱" });
        versionsBtn.title = "View S3 version history";
        versionsBtn.onclick = (e) => {
          e.stopPropagation();
          new FileVersionModal(this.app, this.vault, this.s3, change.key, change.s3Key).open();
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
      this.attachCheckbox(row, change);

      const info = row.createDiv("s3sync-conflict-info");
      const conflictHeader = info.createDiv("s3sync-conflict-header");
      conflictHeader.createSpan({ cls: "s3sync-ext-badge", text: fileTypeBadge(change.key) });
      const pathWrap = conflictHeader.createDiv("s3sync-file-path-wrap");
      pathWrap.title = change.key;
      const parts = change.key.split("/");
      pathWrap.createSpan({ cls: "s3sync-file-name", text: parts[parts.length - 1] });
      const dir = shortenDir(parts);
      if (dir) pathWrap.createSpan({ cls: "s3sync-file-dir", text: dir });
      makePathClickable(pathWrap, this.app, change.key);

      const meta = info.createDiv("s3sync-conflict-meta");
      meta.createSpan({ text: `Local: ${formatAge(change.localMtime)}  ${formatSize(change.localSize)}` });
      meta.createSpan({ text: `Remote: ${formatAge(change.remoteMtime)}  ${formatSize(change.remoteSize)}` });

      const controls = row.createDiv("s3sync-conflict-controls");
      const defaultRes = this.conflictResolutions.get(change.key) ?? "local";
      const localBtn = controls.createEl("button", { cls: `s3sync-conflict-btn ${defaultRes === "local" ? "active" : ""}`, text: "Keep local" });
      const remoteBtn = controls.createEl("button", { cls: `s3sync-conflict-btn ${defaultRes === "remote" ? "active" : ""}`, text: "Keep remote" });
      localBtn.onclick = () => { this.conflictResolutions.set(change.key, "local"); localBtn.addClass("active"); remoteBtn.removeClass("active"); };
      remoteBtn.onclick = () => { this.conflictResolutions.set(change.key, "remote"); remoteBtn.addClass("active"); localBtn.removeClass("active"); };

      this.attachDiffToggle(section, controls, change);
    }
  }

  /** Render a standard file row (checkbox, badges, path, meta). Returns the row element. */
  private renderFileRow(parent: HTMLElement, change: FileChange): HTMLElement {
    const row = parent.createDiv("s3sync-file-row");
    this.attachCheckbox(row, change);

    const badge = change.changeType.includes("new") ? "NEW" : change.changeType.includes("modified") ? "MOD" : "DEL";
    row.createSpan({ cls: `s3sync-type-badge s3sync-type-${badge.toLowerCase()}`, text: badge });
    row.createSpan({ cls: "s3sync-ext-badge", text: fileTypeBadge(change.key) });

    const pathWrap = row.createDiv("s3sync-file-path-wrap");
    pathWrap.title = change.key;
    const parts = change.key.split("/");
    pathWrap.createSpan({ cls: "s3sync-file-name", text: parts[parts.length - 1] });
    const dir = shortenDir(parts);
    if (dir) pathWrap.createSpan({ cls: "s3sync-file-dir", text: dir });
    makePathClickable(pathWrap, this.app, change.key);

    const meta = row.createSpan({ cls: "s3sync-file-meta" });
    const mtime = change.changeType.startsWith("local") ? change.localMtime : change.remoteMtime;
    const size  = change.changeType.startsWith("local") ? change.localSize  : change.remoteSize;
    if (mtime || size) meta.setText(`${formatAge(mtime)}  ${formatSize(size)}`.trim());

    return row;
  }

  /** Attach a checkbox that drives `checkedKeys` selection state. */
  private attachCheckbox(parent: HTMLElement, change: FileChange) {
    const cb = parent.createEl("input", { type: "checkbox", cls: "s3sync-file-checkbox" });
    cb.checked = this.checkedKeys.has(change.key);
    cb.onchange = () => {
      if (cb.checked) this.checkedKeys.add(change.key); else this.checkedKeys.delete(change.key);
      this.updateSyncButton();
    };
  }

  /** Attach a lazy-loading diff toggle button for text files. */
  private attachDiffToggle(section: HTMLElement, toggleParent: HTMLElement, change: FileChange) {
    const canDiff = isTextFile(change.key) && (
      change.changeType === "local_modified" || change.changeType === "remote_modified" || change.changeType === "conflict"
    );
    if (!canDiff) return;

    const panel = section.createDiv("s3sync-diff-panel");
    panel.hide();
    let loaded = false;
    const toggleBtn = toggleParent.createEl("button", { cls: "s3sync-diff-toggle", text: "▶ Diff" });
    toggleBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!panel.isShown()) {
        panel.show(); toggleBtn.setText("▼ diff");
        if (!loaded) { loaded = true; await this.loadAndRenderDiff(panel, change); }
      } else {
        panel.hide(); toggleBtn.setText("▶ Diff");
      }
    };
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
      const decode = (buf: ArrayBuffer) => new TextDecoder("utf-8", { fatal: false }).decode(buf);
      let aText: string, bText: string, aLabel: string, bLabel: string;

      if (change.changeType === "local_modified") {
        const [remoteData, localData] = await Promise.all([this.s3.getObject(change.s3Key), this.vault.adapter.readBinary(change.key)]);
        aText = decode(remoteData); aLabel = "S3 (current)";
        bText = decode(localData);  bLabel = "Local (your edits)";
      } else if (change.changeType === "remote_modified") {
        const [localData, remoteData] = await Promise.all([this.vault.adapter.readBinary(change.key), this.s3.getObject(change.s3Key)]);
        aText = decode(localData);  aLabel = "Local (current)";
        bText = decode(remoteData); bLabel = "S3 (incoming)";
      } else {
        const [localData, remoteData] = await Promise.all([this.vault.adapter.readBinary(change.key), this.s3.getObject(change.s3Key)]);
        aText = decode(localData);  aLabel = "Local";
        bText = decode(remoteData); bLabel = "Remote";
      }

      panel.empty();
      const diffLines = computeDiff(aText, bText);
      if (diffLines.length === 0) { panel.createDiv({ cls: "s3sync-diff-empty", text: "No text differences" }); return; }

      const header = panel.createDiv("s3sync-diff-header");
      header.createSpan({ cls: "s3sync-diff-label-del", text: `− ${aLabel}` });
      header.createSpan({ cls: "s3sync-diff-label-add", text: `+ ${bLabel}` });

      const body = panel.createDiv("s3sync-diff-body");
      if (diffLines.length === 1 && diffLines[0].type === "separator") {
        body.createDiv({ cls: "s3sync-diff-empty", text: "File too large to diff inline (> 600 lines)" });
        return;
      }
      for (const line of diffLines) {
        if (line.type === "separator") { body.createDiv({ cls: "s3sync-diff-separator", text: "⋯" }); continue; }
        const el = body.createDiv({ cls: `s3sync-diff-line s3sync-diff-${line.type}` });
        el.createSpan({ cls: "s3sync-diff-prefix", text: line.type === "added" ? "+" : line.type === "removed" ? "−" : " " });
        el.createSpan({ cls: "s3sync-diff-text", text: line.text || " " });
      }
    } catch (err: unknown) {
      loading.remove();
      panel.createDiv({ cls: "s3sync-diff-error", text: `Failed to load diff: ${extractErrorMessage(err)}` });
    }
  }

  private async doSync() {
    if (!this.syncBtn || !this.progressEl) return;
    this.syncBtn.disabled = true;
    this.progressEl.show();
    this.setSyncing?.(true);

    const onProgress: ProgressCallback = (done, total, file, action) => {
      this.progressEl?.setText(`Syncing… ${done + 1}/${total}  ${action}  ${file}`);
    };

    try {
      const stats = await executeSync(
        this.changes,
        { selectedKeys: this.checkedKeys, conflictResolutions: this.conflictResolutions, message: this.messageInput?.value ?? "" },
        this.vault, this.s3, this.db, onProgress
      );
      // Release the lock BEFORE calling onSyncComplete so the plugin's
      // refreshBadge() — invoked from that callback — isn't blocked by the
      // isSyncing guard. Otherwise the ribbon stays stale until the next poll.
      this.setSyncing?.(false);
      this.onSyncComplete?.();
      this.showResult(stats);
    } catch (err: unknown) {
      this.setSyncing?.(false);
      new Notice(`S3 sync error: ${extractErrorMessage(err)}`, 8000);
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
      if (val > 0) summary.createDiv({ cls: `s3sync-result-row ${cls}` }).setText(`${label}: ${val}`);
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
