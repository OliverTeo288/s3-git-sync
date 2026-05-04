/**
 * Shared UI formatters and DOM helpers for all sync modals.
 */
import { App, Notice, TFile } from "obsidian";

// ─── File type badge ──────────────────────────────────────────────────────────

const EXT_LABELS: Record<string, string> = {
  md: "MD", txt: "TXT", pdf: "PDF", png: "PNG", jpg: "JPG", jpeg: "JPG",
  gif: "GIF", svg: "SVG", webp: "IMG", mp3: "MP3", mp4: "MP4", wav: "WAV",
  webm: "VID", json: "JSON", canvas: "CANVAS", css: "CSS", html: "HTML",
  js: "JS", ts: "TS", excalidraw: "DRAW", csv: "CSV", zip: "ZIP",
};

export function fileTypeBadge(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LABELS[ext] ?? (ext.toUpperCase().slice(0, 5) || "FILE");
}

// ─── Formatters ───────────────────────────────────────────────────────────────

export function formatSize(bytes: number | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatAge(mtime: number | Date | undefined): string {
  if (!mtime) return "";
  const ms = mtime instanceof Date ? mtime.getTime() : mtime;
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Returns the deepest 2 folder segments of a path, prefixed with `…/` if
 * there are more above. Keeps the most informative part visible on narrow modals.
 */
export function shortenDir(parts: string[]): string {
  const dirs = parts.slice(0, -1);
  if (dirs.length === 0) return "";
  if (dirs.length <= 2) return dirs.join("/") + "/";
  return "…/" + dirs.slice(-2).join("/") + "/";
}

// ─── Vault path helpers ───────────────────────────────────────────────────────

async function openInVault(app: App, key: string): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(key);
  if (!(file instanceof TFile)) return false;
  await app.workspace.getLeaf("tab").openFile(file);
  return true;
}

/** Add a click handler that opens `key` in Obsidian if the file exists locally. */
export function makePathClickable(el: HTMLElement, app: App, key: string): void {
  if (!(app.vault.getAbstractFileByPath(key) instanceof TFile)) return;
  el.addClass("s3sync-file-clickable");
  el.title = `${key}\n\nClick to open`;
  el.onclick = async (e) => {
    e.stopPropagation();
    const opened = await openInVault(app, key);
    if (!opened) new Notice("File no longer exists in vault.", 3000);
  };
}

// ─── Shared error banner ──────────────────────────────────────────────────────

import { SSOSessionExpiredError, ssoRelogCommand } from "../s3/errors";
import { extractErrorMessage } from "../utils";

/**
 * Render an error banner inside a modal content element.
 * Shows specialised guidance for SSO expiry; falls back to a plain message.
 */
export function renderErrorBanner(
  contentEl: HTMLElement,
  err: unknown,
  fallbackPrefix = "Failed to load",
): void {
  const banner = contentEl.createDiv({ cls: "s3sync-error-banner" });
  if (err instanceof SSOSessionExpiredError) {
    // eslint-disable-next-line obsidianmd/ui/sentence-case
    banner.createEl("strong", { text: "AWS SSO session expired" });
    banner.createEl("p", { text: "Run this in a terminal, then click retry:" });
    banner.createEl("code", { cls: "s3sync-error-cmd", text: ssoRelogCommand(err.profileName) });
  } else {
    banner.setText(`${fallbackPrefix}: ${extractErrorMessage(err)}`);
  }
}
