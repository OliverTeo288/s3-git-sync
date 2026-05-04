import { Notice, Plugin } from "obsidian";
import { BackupModal, ChangeViewModal, FileVersionModal, HistoryModal } from "./ui/changeView";
import { computeChanges } from "./sync/differ";
import { LocalDB } from "./sync/localdb";
import { S3ClientWrapper } from "./s3/client";
import { SSOSessionExpiredError, ssoRelogCommand } from "./s3/errors";
import { S3GitSyncSettingTab } from "./ui/settings";
import { executeSync, type SyncOptions } from "./sync/engine";
import { DEFAULT_SETTINGS, type FileChange, type S3GitSyncSettings } from "./types";
import { extractErrorMessage, openExternalUrl, triggerBlobDownload } from "./utils";

export default class S3GitSyncPlugin extends Plugin {
  settings!: S3GitSyncSettings;
  db!: LocalDB;

  private s3Client!: S3ClientWrapper;
  private statusBarItem!: HTMLElement;
  private statusBarEl!: HTMLElement;
  private ribbonEl?: HTMLElement;
  private badgePollTimer?: ReturnType<typeof activeWindow.setInterval>;
  private isSyncing = false;
  private lastBadgeCount = -1;

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async onload() {
    await this.loadSettings();

    this.db = new LocalDB(this.app.vault.getName());
    this.s3Client = new S3ClientWrapper(this.settings.s3);

    this.addSettingTab(new S3GitSyncSettingTab(this.app, this));

    this.ribbonEl = this.addRibbonIcon("refresh-cw", "S3 Git sync — view changes", () => {
      this.openChangeView();
    });
    this.ribbonEl.addClass("s3sync-ribbon");

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarEl = this.statusBarItem.createSpan({ cls: "s3sync-statusbar" });
    if (this.settings.showStatusBar) {
      this.updateStatusBar("Ready");
    } else {
      this.statusBarItem.hide();
    }

    this.addCommand({ id: "view-changes", name: "View changes (Git status)", icon: "diff", callback: () => this.openChangeView() });
    this.addCommand({ id: "quick-sync", name: "Quick sync (all changes, default resolutions)", icon: "refresh-cw", callback: () => this.quickSync() });
    this.addCommand({ id: "push-only", name: "Push only (local → S3)", icon: "upload", callback: () => this.directedSync("push") });
    this.addCommand({ id: "pull-only", name: "Pull only (S3 → local)", icon: "download", callback: () => this.directedSync("pull") });
    this.addCommand({ id: "view-history", name: "View sync history (Git log)", icon: "history", callback: () => new HistoryModal(this.app, this.db).open() });
    this.addCommand({ id: "view-version-history", name: "View version history for active file", icon: "clock", callback: () => this.openVersionHistory() });
    this.addCommand({
      id: "export-backup",
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      name: "Export S3 backup (download all files as ZIP)",
      icon: "archive",
      callback: () => this.exportBackup(),
    });

    if (this.settings.badgePollIntervalMin > 0) this.startBadgePoll();
  }

  onunload() { this.stopBadgePoll(); }

  // ── Settings ──────────────────────────────────────────────────────────────────

  async loadSettings() {
    const saved = (await this.loadData()) as Partial<S3GitSyncSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
    this.settings.s3 = { ...DEFAULT_SETTINGS.s3, ...(saved?.s3 ?? {}) };

    if (saved == null) {
      const dir = this.app.vault.configDir;
      this.settings.ignorePatterns = [`${dir}/workspace.json`, `${dir}/workspace-mobile.json`, ...this.settings.ignorePatterns];
    }

    // Always ensure built-in required patterns are present, even for existing
    // installs whose saved settings predate them being added as defaults.
    const required = DEFAULT_SETTINGS.ignorePatterns;
    for (const p of required) {
      if (!this.settings.ignorePatterns.includes(p)) {
        this.settings.ignorePatterns.push(p);
      }
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.s3Client = new S3ClientWrapper(this.settings.s3);
  }

  getS3Client(): S3ClientWrapper { return this.s3Client; }

  // ── Status bar ────────────────────────────────────────────────────────────────

  updateStatusBar(msg: string) {
    if (!this.settings.showStatusBar) return;
    this.statusBarEl.setText(`☁ ${msg}`);
  }

  setStatusBarVisible(visible: boolean) {
    if (visible) { this.statusBarItem.show(); this.updateStatusBar("Ready"); }
    else { this.statusBarItem.hide(); }
  }

  // ── Ribbon badge ──────────────────────────────────────────────────────────────

  updateRibbonBadge(count: number) {
    if (!this.ribbonEl || count === this.lastBadgeCount) return;
    this.lastBadgeCount = count;
    this.ribbonEl.querySelector(".s3sync-ribbon-badge")?.remove();
    if (count > 0) {
      const badge = this.ribbonEl.createSpan({ cls: "s3sync-ribbon-badge" });
      badge.setText(count > 99 ? "99+" : String(count));
    }
    this.ribbonEl.title = count > 0
      ? `S3 Git Sync — ${count} pending change${count !== 1 ? "s" : ""}`
      : "S3 Git Sync — view changes";
  }

  startBadgePoll() {
    this.stopBadgePoll();
    if (this.settings.badgePollIntervalMin <= 0) return;
    this.badgePollTimer = activeWindow.setInterval(() => this.refreshBadge(), this.settings.badgePollIntervalMin * 60_000);
    void this.refreshBadge();
  }

  stopBadgePoll() {
    if (this.badgePollTimer != null) {
      activeWindow.clearInterval(this.badgePollTimer);
      this.badgePollTimer = undefined;
    }
  }

  restartBadgePoll() { this.startBadgePoll(); }

  private async refreshBadge() {
    if (this.isSyncing) return;
    try {
      const { changes } = await computeChanges(this.app.vault, this.s3Client, this.db, this.settings);
      this.updateRibbonBadge(changes.length);
    } catch { /* badge poll failures are silent */ }
  }

  // ── Settings portability ──────────────────────────────────────────────────────

  exportSettings() {
    const { s3AccessKeyID: _id, s3SecretAccessKey: _secret, ...safeS3 } = this.settings.s3;
    const json = JSON.stringify({ ...this.settings, s3: safeS3 }, null, 2);
    triggerBlobDownload(json, `s3-git-sync-settings-${new Date().toISOString().slice(0, 10)}.json`, "application/json");
    new Notice("Settings exported (credentials excluded).", 4000);
  }

  importSettings() {
    const input = activeDocument.createEl("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      const file = input.files?.[0];
      input.remove(); // prevent DOM leak
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text()) as Partial<S3GitSyncSettings>;
        const { s3: parsedS3, ...rest } = parsed;
        this.settings = {
          ...this.settings, ...rest,
          s3: { ...this.settings.s3, ...parsedS3, s3AccessKeyID: this.settings.s3.s3AccessKeyID, s3SecretAccessKey: this.settings.s3.s3SecretAccessKey },
        };
        await this.saveSettings();
        new Notice("Settings imported. Credentials were not overwritten.", 5000);
      } catch (err: unknown) {
        new Notice(`Failed to import settings: ${extractErrorMessage(err)}`, 5000);
      }
    };
    input.click();
  }

  // ── Version history / backup ──────────────────────────────────────────────────

  openVersionHistory() {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice("No active file."); return; }
    const s3Key = this.s3Client.vaultKeyToS3Key(file.path);
    new FileVersionModal(this.app, this.app.vault, this.s3Client, file.path, s3Key).open();
  }

  exportBackup() {
    new BackupModal(this.app, this.s3Client, this.app.vault.getName()).open();
  }

  // ── Error handling ────────────────────────────────────────────────────────────

  openExternalBrowser(url: string): void { openExternalUrl(url); }

  handleSyncError(err: unknown, prefix: string): void {
    if (err instanceof SSOSessionExpiredError) {
      new Notice(
        `AWS SSO session expired.\n\nRun in a terminal:\n  ${ssoRelogCommand(err.profileName)}\n\nThen retry the sync.`,
        15_000
      );
      return;
    }
    new Notice(`${prefix}: ${extractErrorMessage(err)}`, 8_000);
  }

  // ── Core sync actions ─────────────────────────────────────────────────────────

  openChangeView() {
    if (this.isSyncing) { new Notice("A sync is already in progress."); return; }
    new ChangeViewModal(
      this.app, this.app.vault, this.s3Client, this.db, this.settings,
      () => {
        const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        this.updateStatusBar(`Synced ${ts}`);
        void this.refreshBadge();
      },
      // Hold the global lock during modal sync so the badge poller and
      // command-palette syncs can't run concurrently against the same DB.
      (busy) => { this.isSyncing = busy; },
    ).open();
  }

  async quickSync() { await this.performSync("quick"); }
  async directedSync(direction: "push" | "pull") { await this.performSync(direction); }

  /**
   * Shared sync scaffold for quick-sync and directed push/pull.
   * Handles locking, progress notices, error handling, and badge refresh.
   */
  private async performSync(direction: "quick" | "push" | "pull"): Promise<void> {
    if (this.isSyncing) { new Notice("A sync is already in progress."); return; }

    const labels = { quick: "Syncing", push: "Pushing", pull: "Pulling" } as const;
    const label = labels[direction];
    this.isSyncing = true;
    this.updateStatusBar(`${label}…`);
    const notice = new Notice(`${label}…`, 0);

    try {
      const { changes } = await computeChanges(this.app.vault, this.s3Client, this.db, this.settings);
      const { syncable, opts } = this.filterChanges(direction, changes, notice);
      if (!syncable) return; // early-exit already handled inside filterChanges

      const stats = await executeSync(syncable, opts, this.app.vault, this.s3Client, this.db,
        (done, total, file) => {
          this.updateStatusBar(`${done + 1}/${total}`);
          notice.setMessage(`${label} ${done + 1}/${total}: ${file}`);
        }
      );

      notice.hide();
      const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      if (direction === "quick") {
        this.updateStatusBar(`Synced ${ts}`);
        const summary = [
          stats.uploaded && `↑${stats.uploaded}`, stats.downloaded && `↓${stats.downloaded}`,
          stats.deletedFromS3 && `✕${stats.deletedFromS3}`, stats.deletedFromLocal && `✕${stats.deletedFromLocal}`,
        ].filter(Boolean).join(" ");
        new Notice(`Sync complete: ${summary}`, 5000);
        if (stats.errors.length > 0) {
          new Notice(`⚠ ${stats.errors.length} file(s) failed to sync. Check console.`, 8000);
          stats.errors.forEach((e) => console.error("[S3 Git Sync]", e));
        }
      } else {
        this.updateStatusBar(`${direction === "push" ? "Pushed" : "Pulled"} ${ts}`);
        new Notice(`${label} complete: ${stats.uploaded + stats.downloaded} file(s).`, 4000);
      }
    } catch (err: unknown) {
      notice.hide();
      this.updateStatusBar("Error");
      this.handleSyncError(err, `${label} failed`);
    } finally {
      this.isSyncing = false;
      void this.refreshBadge();
    }
  }

  /** Filter raw changes for the given direction and build SyncOptions. */
  private filterChanges(
    direction: "quick" | "push" | "pull",
    changes: FileChange[],
    notice: Notice,
  ): { syncable: FileChange[] | null; opts: SyncOptions } {
    if (direction === "quick") {
      const conflictCount = changes.filter((c) => c.changeType === "conflict").length;
      const syncable = changes.filter((c) => c.changeType !== "conflict");
      if (conflictCount > 0) {
        new Notice(`${conflictCount} conflict${conflictCount > 1 ? "s" : ""} need manual resolution — open View Changes to resolve them.`, 8_000);
      }
      if (syncable.length === 0) {
        notice.hide(); this.updateStatusBar("Up to date"); new Notice("Everything is up to date.", 3000);
        return { syncable: null, opts: {} };
      }
      return { syncable, opts: {} };
    }

    const PUSH_TYPES = new Set(["local_new", "local_modified", "local_deleted", "conflict"]);
    const PULL_TYPES = new Set(["remote_new", "remote_modified", "remote_deleted", "conflict"]);
    const types = direction === "push" ? PUSH_TYPES : PULL_TYPES;
    const syncable = changes.filter((c) => types.has(c.changeType));
    if (syncable.length === 0) {
      notice.hide(); this.updateStatusBar("Up to date"); new Notice(`Nothing to ${direction}`, 3000);
      return { syncable: null, opts: {} };
    }
    const conflictResolutions = new Map(
      syncable.filter((c) => c.changeType === "conflict")
        .map((c) => [c.key, direction === "push" ? ("local" as const) : ("remote" as const)])
    );
    return { syncable, opts: { conflictResolutions } };
  }
}
