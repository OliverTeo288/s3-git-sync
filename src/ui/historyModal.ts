import { App, Modal } from "obsidian";
import type { LocalDB } from "../sync/localdb";
import type { SyncHistoryEntry } from "../types";

export class HistoryModal extends Modal {
  private readonly db: LocalDB;

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
      for (const entry of entries) this.renderEntry(list, entry);
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
        fileList.createDiv({ cls: "s3sync-history-file", text: `${ACTION_SYMBOL[f.action] ?? "·"}  ${f.key}` });
      }
    }
  }

  onClose() { this.contentEl.empty(); }
}
