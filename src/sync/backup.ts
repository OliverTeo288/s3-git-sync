import { zip, type AsyncZipOptions, type AsyncZippable } from "fflate";
import type { RemoteObject } from "../types";
import type { S3ClientWrapper } from "../s3/client";
import { extractErrorMessage } from "../utils";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BackupProgress {
  done: number;
  total: number;
  currentFile: string;
}

export type BackupProgressCallback = (p: BackupProgress) => void;

export interface BackupResult {
  /** Files successfully downloaded: vault-relative path → bytes */
  files: Map<string, Uint8Array>;
  /** Files that failed to download: "path: error message" */
  errors: string[];
}

// ─── Download ─────────────────────────────────────────────────────────────────

const CONCURRENCY = 5;

/**
 * Download all S3 objects with a bounded concurrency pool.
 * Failures are collected in `errors` rather than aborting the whole run,
 * so the user still gets a partial backup of what succeeded.
 */
export async function downloadAll(
  objects: RemoteObject[],
  s3: S3ClientWrapper,
  onProgress: BackupProgressCallback,
  signal: AbortSignal,
): Promise<BackupResult> {
  const files = new Map<string, Uint8Array>();
  const errors: string[] = [];
  // JS is single-threaded so `idx` access inside the workers is race-free.
  let idx = 0;
  let done = 0;

  async function worker() {
    while (idx < objects.length) {
      if (signal.aborted) return;
      const obj = objects[idx++];
      try {
        const data = await s3.getObject(obj.s3Key);
        files.set(obj.vaultKey, new Uint8Array(data));
      } catch (err: unknown) {
        errors.push(`${obj.vaultKey}: ${extractErrorMessage(err)}`);
      }
      onProgress({ done: ++done, total: objects.length, currentFile: obj.vaultKey });
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { files, errors };
}

// ─── ZIP packaging ────────────────────────────────────────────────────────────

/**
 * Package a map of vault-relative paths → bytes into a ZIP archive.
 * Uses compression level 1 (fastest) as most vault content is already
 * compact or will not compress significantly (images, PDFs).
 */
export function buildZip(files: Map<string, Uint8Array>): Promise<Uint8Array> {
  const opts: AsyncZipOptions = { level: 1 };
  const entries: AsyncZippable = {};
  for (const [path, bytes] of files) {
    entries[path] = [bytes, opts];
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    zip(entries, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a deterministic backup filename.
 * Vault names are sanitised to be filesystem-safe.
 * Example: "s3-backup-my-vault-2026-04-30.zip"
 */
export function backupFilename(vaultName: string, date = new Date()): string {
  const d = date.toISOString().slice(0, 10);
  const safe = vaultName.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-{2,}/g, "-").toLowerCase();
  return `s3-backup-${safe}-${d}.zip`;
}


/** Total byte count of a backup result */
export function totalBytes(files: Map<string, Uint8Array>): number {
  let n = 0;
  for (const bytes of files.values()) n += bytes.byteLength;
  return n;
}
