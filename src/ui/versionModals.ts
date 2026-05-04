import { App, Modal, Notice } from "obsidian";
import type { Vault } from "obsidian";
import type { S3ClientWrapper } from "../s3/client";
import { ensureParentFolder } from "../sync/engine";
import type { ObjectVersion } from "../types";
import { formatSize, renderErrorBanner } from "./uiHelpers";
import { isTextFile } from "../sync/diffEngine";
import { extractErrorMessage } from "../utils";

// ─── File Version History Modal ───────────────────────────────────────────────

export class FileVersionModal extends Modal {
  constructor(
    app: App,
    private readonly vault: Vault,
    private readonly s3: S3ClientWrapper,
    private readonly vaultKey: string,
    private readonly s3Key: string,
  ) { super(app); }

  async onOpen() {
    const { contentEl } = this;
    const filename = this.vaultKey.split("/").pop() ?? this.vaultKey;
    this.renderHeader(contentEl, filename);
    contentEl.createDiv({ cls: "s3sync-loading", text: "Loading versions…" });

    try {
      const versions = await this.s3.listObjectVersions(this.s3Key);
      contentEl.empty();
      contentEl.addClass("s3sync-modal");
      this.renderHeader(contentEl, filename);

      if (versions.length === 0) {
        contentEl.createDiv({
          cls: "s3sync-empty",
          text: "No versions found. S3 versioning may not be enabled on this bucket.",
        });
      } else {
        contentEl.createEl("p", {
          cls: "s3sync-version-hint",
          text: `${versions.length} version${versions.length !== 1 ? "s" : ""} — restore writes directly to your local vault.`,
        });
        const list = contentEl.createDiv("s3sync-version-list");
        for (const v of versions) this.renderVersion(list, v);
      }
    } catch (err: unknown) {
      contentEl.empty();
      contentEl.addClass("s3sync-modal");
      renderErrorBanner(contentEl, err, "Failed to load versions");
    }

    contentEl.createEl("button", { cls: "mod-cta s3sync-version-close-btn", text: "Close" })
      .onclick = () => this.close();
  }

  private renderHeader(el: HTMLElement, filename: string) {
    el.addClass("s3sync-modal");
    el.createEl("h2", { text: "Version history" });
    el.createEl("p", { cls: "s3sync-version-filename", text: filename });
  }

  private renderVersion(parent: HTMLElement, v: ObjectVersion) {
    const row = parent.createDiv("s3sync-version-row");
    const info = row.createDiv("s3sync-version-info");
    if (v.isLatest) info.createSpan({ cls: "s3sync-version-current-badge", text: "CURRENT" });
    info.createSpan({ cls: "s3sync-version-time", text: new Date(v.lastModified).toLocaleString() });
    info.createSpan({ cls: "s3sync-version-meta", text: `${formatSize(v.size)}  ·  ${v.versionId.slice(0, 8)}…` });

    const actions = row.createDiv("s3sync-version-actions");
    if (isTextFile(this.vaultKey)) this.attachPreviewButton(actions, v);
    if (!v.isLatest) this.attachRestoreButton(actions, v);
  }

  private attachPreviewButton(parent: HTMLElement, v: ObjectVersion) {
    const btn = parent.createEl("button", { text: "Preview" });
    btn.onclick = async () => {
      btn.disabled = true;
      btn.setText("Loading…");
      try {
        const data = await this.s3.getObjectVersion(this.s3Key, v.versionId);
        const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
        new VersionPreviewModal(this.app, this.vaultKey, v, text).open();
      } catch (err: unknown) {
        new Notice(`Failed to load version: ${extractErrorMessage(err)}`, 5000);
      } finally {
        btn.disabled = false;
        btn.setText("Preview");
      }
    };
  }

  private attachRestoreButton(parent: HTMLElement, v: ObjectVersion) {
    const btn = parent.createEl("button", { cls: "mod-warning", text: "Restore" });
    btn.onclick = async () => {
      btn.disabled = true;
      btn.setText("Restoring…");
      try {
        const data = await this.s3.getObjectVersion(this.s3Key, v.versionId);
        await ensureParentFolder(this.vault, this.vaultKey);
        await this.vault.adapter.writeBinary(this.vaultKey, data);
        const name = this.vaultKey.split("/").pop() ?? this.vaultKey;
        new Notice(`Restored ${name} to version from ${new Date(v.lastModified).toLocaleString()}`, 5000);
        this.close();
      } catch (err: unknown) {
        new Notice(`Restore failed: ${extractErrorMessage(err)}`, 5000);
        btn.disabled = false;
        btn.setText("Restore");
      }
    };
  }

  onClose() { this.contentEl.empty(); }
}

// ─── Version Preview Modal ────────────────────────────────────────────────────

export class VersionPreviewModal extends Modal {
  constructor(
    app: App,
    private readonly vaultKey: string,
    private readonly version: ObjectVersion,
    private readonly text: string,
  ) { super(app); }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("s3sync-modal");
    const filename = this.vaultKey.split("/").pop() ?? this.vaultKey;
    contentEl.createEl("h3", { text: filename });
    contentEl.createEl("p", {
      cls: "s3sync-version-preview-meta",
      text: `${new Date(this.version.lastModified).toLocaleString()}  ·  ${formatSize(this.version.size)}`,
    });
    const pre = contentEl.createEl("pre", { cls: "s3sync-version-preview" });
    pre.createEl("code", { text: this.text.slice(0, 5000) });
    if (this.text.length > 5000) {
      contentEl.createEl("p", { cls: "s3sync-diff-empty", text: "Preview truncated at 5 000 characters." });
    }
    contentEl.createEl("button", { cls: "mod-cta", text: "Close" }).onclick = () => this.close();
  }

  onClose() { this.contentEl.empty(); }
}
