import { Notice, Platform, Plugin } from "obsidian";
import { ChangeViewModal, HistoryModal } from "./changeView";
import { computeChanges } from "./differ"; // still used by quickSync / directedSync
import { LocalDB } from "./localdb";
import { S3ClientWrapper, SSOSessionExpiredError } from "./s3client";
import { S3GitSyncSettingTab } from "./settings";
import { executeSync } from "./syncEngine";
import { DEFAULT_SETTINGS, type S3GitSyncSettings } from "./types";

export default class S3GitSyncPlugin extends Plugin {
  settings!: S3GitSyncSettings;
  db!: LocalDB;

  private s3Client!: S3ClientWrapper;
  private statusBarEl?: HTMLElement;
  private isSyncing = false;

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async onload() {
    await this.loadSettings();

    this.db = new LocalDB(this.app.vault.getName());
    this.s3Client = new S3ClientWrapper(this.settings.s3);

    this.addSettingTab(new S3GitSyncSettingTab(this.app, this));

    // Ribbon: click to open change view
    this.addRibbonIcon("refresh-cw", "S3 Git sync — view changes", () => {
      this.openChangeView();
    });

    // Status bar
    if (this.settings.showStatusBar) {
      const item = this.addStatusBarItem();
      this.statusBarEl = item.createSpan({ cls: "s3sync-statusbar" });
      this.updateStatusBar("Ready");
    }

    // ── Commands ─────────────────────────────────────────────────────────────

    this.addCommand({
      id: "view-changes",
      name: "View changes (Git status)",
      icon: "diff",
      callback: () => this.openChangeView(),
    });

    this.addCommand({
      id: "quick-sync",
      name: "Quick sync (all changes, default resolutions)",
      icon: "refresh-cw",
      callback: () => this.quickSync(),
    });

    this.addCommand({
      id: "push-only",
      name: "Push only (local → S3)",
      icon: "upload",
      callback: () => this.directedSync("push"),
    });

    this.addCommand({
      id: "pull-only",
      name: "Pull only (S3 → local)",
      icon: "download",
      callback: () => this.directedSync("pull"),
    });

    this.addCommand({
      id: "view-history",
      name: "View sync history (Git log)",
      icon: "history",
      callback: () => new HistoryModal(this.app, this.db).open(),
    });

  }

  // ── Settings ──────────────────────────────────────────────────────────────────

  async loadSettings() {
    const saved = (await this.loadData()) as Partial<S3GitSyncSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
    // Deep-merge S3 config
    this.settings.s3 = { ...DEFAULT_SETTINGS.s3, ...(saved?.s3 ?? {}) };

    // First-run: prepend workspace files (resolved against the user's actual config dir)
    // to the default ignore list so we never sync them.
    if (saved == null) {
      const dir = this.app.vault.configDir;
      this.settings.ignorePatterns = [
        `${dir}/workspace.json`,
        `${dir}/workspace-mobile.json`,
        ...this.settings.ignorePatterns,
      ];
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Rebuild the S3 client whenever credentials change
    this.s3Client = new S3ClientWrapper(this.settings.s3);
  }

  /** Expose the current S3 client to the settings tab for connection testing */
  getS3Client(): S3ClientWrapper {
    return this.s3Client;
  }

  // ── Status bar ────────────────────────────────────────────────────────────────

  updateStatusBar(msg: string) {
    if (!this.statusBarEl) return;
    // Unicode cloud icon keeps it compact and visually distinct in the status bar
    this.statusBarEl.setText(`☁ ${msg}`);
  }

  // ── Error handling ────────────────────────────────────────────────────────────

  /**
   * Open a URL in the system default browser.
   * electron.shell is a main-process API and is not accessible from the renderer;
   * spawning the OS-native open command via child_process is the reliable path.
   */
  openExternalBrowser(url: string): void {
    if (Platform.isDesktop) {
      try {
        // eslint-disable-next-line obsidianmd/prefer-active-doc -- accessing Electron's CommonJS require, not the document
        const req = (globalThis as Record<string, unknown>)["require"] as (id: string) => unknown;
        const { platform } = req("process") as { platform: string };
        const cp = req("child_process") as {
          spawn: (cmd: string, args: string[], opts: object) => { unref: () => void };
        };
        if (platform === "darwin") {
          cp.spawn("open", [url], { detached: true }).unref();
        } else if (platform === "win32") {
          cp.spawn("cmd", ["/c", "start", "", url], { detached: true }).unref();
        } else {
          cp.spawn("xdg-open", [url], { detached: true }).unref();
        }
        return;
      } catch { /* fall through */ }
    }
    window.open(url, "_blank");
  }

  /**
   * Unified sync error handler. Detects expired SSO sessions and opens the
   * browser for re-authentication; shows a generic notice for all other errors.
   */
  handleSyncError(err: unknown, prefix: string): void {
    if (err instanceof SSOSessionExpiredError) {
      new Notice(
        `AWS SSO session expired.\n\nRun in a terminal:\n  aws sso login --profile ${err.profileName}\n\nThen retry the sync.`,
        15_000
      );
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    new Notice(`${prefix}: ${msg}`, 8_000);
  }

  // ── Core sync actions ─────────────────────────────────────────────────────────

  /** Open the change-preview modal — the full "git status + git commit" workflow */
  openChangeView() {
    if (this.isSyncing) {
      new Notice("A sync is already in progress.");
      return;
    }
    new ChangeViewModal(
      this.app,
      this.app.vault,
      this.s3Client,
      this.db,
      this.settings
    ).open();
  }

  /** Sync without the interactive modal — conflicts are skipped and flagged for manual resolution */
  async quickSync() {
    if (this.isSyncing) return;
    this.isSyncing = true;
    this.updateStatusBar("Syncing…");

    const notice = new Notice("Syncing…", 0);

    try {
      const { changes } = await computeChanges(
        this.app.vault,
        this.s3Client,
        this.db,
        this.settings
      );

      if (changes.length === 0) {
        notice.hide();
        this.updateStatusBar("Up to date");
        new Notice("Everything is up to date.", 3000);
        return;
      }

      const conflictCount = changes.filter((c) => c.changeType === "conflict").length;
      const syncable = changes.filter((c) => c.changeType !== "conflict");

      if (conflictCount > 0) {
        new Notice(
          `${conflictCount} conflict${conflictCount > 1 ? "s" : ""} need manual resolution — open View Changes to resolve them.`,
          8_000
        );
      }

      if (syncable.length === 0) {
        notice.hide();
        this.updateStatusBar("Up to date");
        new Notice("Everything is up to date.", 3000);
        return;
      }

      const stats = await executeSync(
        syncable,
        {},
        this.app.vault,
        this.s3Client,
        this.db,
        (done, total, file, _action) => {
          this.updateStatusBar(`${done + 1}/${total}`);
          notice.setMessage(`Syncing ${done + 1}/${total}: ${file}`);
        }
      );

      notice.hide();
      const summary = [
        stats.uploaded && `↑${stats.uploaded}`,
        stats.downloaded && `↓${stats.downloaded}`,
        stats.deletedFromS3 && `✕${stats.deletedFromS3}`,
        stats.deletedFromLocal && `✕${stats.deletedFromLocal}`,
      ]
        .filter(Boolean)
        .join(" ");

      const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      this.updateStatusBar(`Synced ${ts}`);
      new Notice(`Sync complete: ${summary}`, 5000);
      if (stats.errors.length > 0) {
        new Notice(`⚠ ${stats.errors.length} file(s) failed to sync. Check console.`, 8000);
        stats.errors.forEach((e) => console.error("[S3 Git Sync]", e));
      }
    } catch (err: unknown) {
      notice.hide();
      this.updateStatusBar("Error");
      this.handleSyncError(err, "Sync failed");
    } finally {
      this.isSyncing = false;
    }
  }

  /** Only upload (push) or only download (pull) — skips the other direction */
  async directedSync(direction: "push" | "pull") {
    if (this.isSyncing) {
      new Notice("A sync is already in progress.");
      return;
    }
    this.isSyncing = true;
    this.updateStatusBar(`${direction === "push" ? "Pushing" : "Pulling"}…`);

    const notice = new Notice(`${direction === "push" ? "Pushing" : "Pulling"}…`, 0);

    try {
      const { changes } = await computeChanges(
        this.app.vault,
        this.s3Client,
        this.db,
        this.settings
      );

      // Filter to only the relevant direction
      const filtered = changes.filter((c) => {
        if (direction === "push") {
          return c.changeType === "local_new" ||
            c.changeType === "local_modified" ||
            c.changeType === "local_deleted" ||
            c.changeType === "conflict";
        } else {
          return c.changeType === "remote_new" ||
            c.changeType === "remote_modified" ||
            c.changeType === "remote_deleted" ||
            c.changeType === "conflict";
        }
      });

      if (filtered.length === 0) {
        notice.hide();
        this.updateStatusBar("Up to date");
        new Notice("Nothing to " + direction, 3000);
        return;
      }

      const conflictOverride = new Map(
        filtered
          .filter((c) => c.changeType === "conflict")
          .map((c) => [c.key, direction === "push" ? ("local" as const) : ("remote" as const)])
      );

      const stats = await executeSync(
        filtered,
        { conflictResolutions: conflictOverride },
        this.app.vault,
        this.s3Client,
        this.db,
        (done, total, file) => {
          notice.setMessage(`${direction === "push" ? "Pushing" : "Pulling"} ${done + 1}/${total}: ${file}`);
        }
      );

      notice.hide();
      const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      this.updateStatusBar(`${direction === "push" ? "Pushed" : "Pulled"} ${ts}`);
      new Notice(
        `${direction === "push" ? "Push" : "Pull"} complete: ${stats.uploaded + stats.downloaded} file(s).`,
        4000
      );
    } catch (err: unknown) {
      notice.hide();
      this.updateStatusBar("Error");
      this.handleSyncError(err, `${direction} failed`);
    } finally {
      this.isSyncing = false;
    }
  }
}
