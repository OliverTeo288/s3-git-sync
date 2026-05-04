import { App, Modal } from "obsidian";
import { backupFilename, buildZip, downloadAll, totalBytes } from "../sync/backup";
import type { S3ClientWrapper } from "../s3/client";
import type { RemoteObject } from "../types";
import { formatSize } from "./uiHelpers";
import { extractErrorMessage, triggerBlobDownload } from "../utils";

export class BackupModal extends Modal {
  private abortController = new AbortController();

  constructor(
    app: App,
    private readonly s3: S3ClientWrapper,
    private readonly vaultName: string,
  ) { super(app); }

  async onOpen() {
    const { contentEl } = this;
    contentEl.addClass("s3sync-modal");
    contentEl.createEl("h2", { text: "Export S3 backup" });

    const listingEl = contentEl.createDiv({ cls: "s3sync-loading", text: "Listing S3 objects…" });

    let objects: RemoteObject[];
    try {
      objects = await this.s3.listObjects();
    } catch (err: unknown) {
      listingEl.remove();
      contentEl.createDiv({ cls: "s3sync-error-banner", text: `Failed to list objects: ${extractErrorMessage(err)}` });
      contentEl.createEl("button", { cls: "mod-cta", text: "Close" }).onclick = () => this.close();
      return;
    }

    listingEl.remove();

    if (objects.length === 0) {
      contentEl.createDiv({ cls: "s3sync-empty", text: "No files found in the S3 bucket under the configured prefix." });
      contentEl.createEl("button", { cls: "mod-cta", text: "Close" }).onclick = () => this.close();
      return;
    }

    const remoteBytes = objects.reduce((n, o) => n + o.size, 0);
    contentEl.createEl("p", {
      cls: "s3sync-backup-summary",
      text: `${objects.length} file${objects.length !== 1 ? "s" : ""}  ·  ${formatSize(remoteBytes)} on S3`,
    });

    const { progressEl, barFill, progressText } = this.buildProgressUI(contentEl);
    this.buildFooter(contentEl, objects, remoteBytes, progressEl, barFill, progressText);
  }

  private buildProgressUI(contentEl: HTMLElement) {
    const progressEl = contentEl.createDiv("s3sync-backup-progress");
    progressEl.hide();
    const barFill = progressEl.createDiv("s3sync-backup-bar-wrap").createDiv("s3sync-backup-bar-fill");
    const progressText = progressEl.createDiv({ cls: "s3sync-backup-progress-text" });
    return { progressEl, barFill, progressText };
  }

  private buildFooter(
    contentEl: HTMLElement,
    objects: RemoteObject[],
    remoteBytes: number,
    progressEl: HTMLElement,
    barFill: HTMLElement,
    progressText: HTMLElement,
  ) {
    const footerRow = contentEl.createDiv("s3sync-footer").createDiv("s3sync-footer-primary");
    const cancelBtn = footerRow.createEl("button", { text: "Cancel" });
    const startBtn = footerRow.createEl("button", {
      cls: "mod-cta",
      text: `Download backup (${formatSize(remoteBytes)})`,
    });

    cancelBtn.onclick = () => { this.abortController.abort(); this.close(); };
    startBtn.onclick = async () => {
      startBtn.disabled = true;
      progressEl.show();
      await this.runDownload(objects, barFill, progressText, startBtn);
    };
  }

  private async runDownload(
    objects: RemoteObject[],
    barFill: HTMLElement,
    progressText: HTMLElement,
    startBtn: HTMLButtonElement,
  ) {
    try {
      const { files, errors } = await downloadAll(
        objects,
        this.s3,
        ({ done, total, currentFile }) => {
          barFill.setCssProps({ "--s3sync-bar-pct": `${Math.round((done / total) * 100)}%` });
          progressText.setText(`Downloading ${done} / ${total}  —  ${currentFile}`);
        },
        this.abortController.signal,
      );

      if (this.abortController.signal.aborted) return;

      progressText.setText(`Packaging ${files.size} files…`);
      barFill.setCssProps({ "--s3sync-bar-pct": "100%" });

      const zipData = await buildZip(files);
      const filename = backupFilename(this.vaultName);
      triggerBlobDownload(zipData.buffer as ArrayBuffer, filename, "application/zip");
      this.renderComplete(files.size, totalBytes(files), filename, errors);
    } catch (err: unknown) {
      if (this.abortController.signal.aborted) return;
      progressText.setText(`Error: ${extractErrorMessage(err)}`);
      progressText.addClass("s3sync-diff-error");
      startBtn.disabled = false;
      startBtn.setText("Retry");
    }
  }

  private renderComplete(fileCount: number, bytes: number, filename: string, errors: string[]) {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("s3sync-modal");
    contentEl.createEl("h2", { text: "Backup complete" });
    contentEl.createEl("p", {
      text: `${fileCount} file${fileCount !== 1 ? "s" : ""}  ·  ${formatSize(bytes)} uncompressed  →  ${filename}`,
    });
    if (errors.length > 0) {
      contentEl.createEl("h4", { text: `${errors.length} file${errors.length !== 1 ? "s" : ""} failed` });
      const list = contentEl.createEl("ul", { cls: "s3sync-error-list" });
      errors.forEach((e) => list.createEl("li", { text: e }));
    }
    contentEl.createEl("button", { cls: "mod-cta", text: "Close" }).onclick = () => this.close();
  }

  onClose() {
    this.abortController.abort();
    this.contentEl.empty();
  }
}
