/**
 * Shared utility functions used across multiple modules.
 * Each function solves a single, specific problem.
 */
import { Platform } from "obsidian";

/** Extract a human-readable message from any thrown value. */
export function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reject vault paths that could escape the vault root or interact with
 * platform-specific reserved syntax. S3 keys are attacker-controllable in
 * shared/mis-ACL'd buckets, so every path that reaches `vault.adapter` must
 * pass this check first.
 *
 * Rejects: `..` segments, absolute paths (`/foo`, `\foo`, `C:\…`), backslashes
 * (Windows separator), and embedded NUL bytes.
 */
export function assertSafeVaultKey(key: string): void {
  if (!key) throw new Error("Empty vault key");
  if (key.includes("\0")) throw new Error(`Vault key contains NUL byte: ${JSON.stringify(key)}`);
  if (key.includes("\\")) throw new Error(`Vault key contains backslash (Windows separator): ${JSON.stringify(key)}`);
  if (key.startsWith("/")) throw new Error(`Vault key is absolute: ${JSON.stringify(key)}`);
  if (/^[A-Za-z]:/.test(key)) throw new Error(`Vault key looks like a Windows drive path: ${JSON.stringify(key)}`);
  for (const seg of key.split("/")) {
    if (seg === "..") throw new Error(`Vault key contains parent-directory segment: ${JSON.stringify(key)}`);
  }
}

/** Match valid AWS profile names — characters allowed in `~/.aws/config` section headers. */
const AWS_PROFILE_NAME_RE = /^[A-Za-z0-9_.@:/+=-]+$/;

/** Validate an AWS profile name; throws on invalid input. Profile names flow into `child_process.spawn`. */
export function assertSafeProfileName(profileName: string): void {
  if (!AWS_PROFILE_NAME_RE.test(profileName)) {
    throw new Error(`Invalid AWS profile name: ${JSON.stringify(profileName)}`);
  }
}

/**
 * Access Electron's CommonJS `require` from the renderer process.
 * Throws if called outside Electron (desktop only).
 */
export function nodeRequire(id: string): unknown {
  // eslint-disable-next-line obsidianmd/prefer-active-doc -- accessing Electron's CommonJS require, not the document
  const rq = (globalThis as Record<string, unknown>)["require"];
  if (typeof rq !== "function") throw new Error(`require("${id}") is not available outside Electron.`);
  return (rq as (id: string) => unknown)(id);
}

/** Trigger a browser/Electron file download by synthesising a temporary anchor. */
export function triggerBlobDownload(data: BlobPart, filename: string, mimeType: string): void {
  const blob = new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = activeDocument.createEl("a");
  a.href = url;
  a.download = filename;
  activeDocument.body.appendChild(a);
  a.click();
  activeDocument.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Open a URL in the system default browser.
 * Routes through Electron's child_process on desktop to avoid renderer
 * restrictions; falls back to window.open on mobile/web.
 */
export function openExternalUrl(url: string): void {
  if (Platform.isDesktop) {
    try {
      const req = nodeRequire;
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
    } catch { /* fall through to window.open */ }
  }
  window.open(url, "_blank");
}
