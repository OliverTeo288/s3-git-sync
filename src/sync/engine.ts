import { nanoid } from "nanoid";
import { TFile, type Vault } from "obsidian";
import type { LocalDB } from "./localdb";
import type { S3ClientWrapper } from "../s3/client";
import type {
  FileChange,
  SyncFileRecord,
  SyncRecord,
  SyncStats,
} from "../types";
import { assertSafeVaultKey, extractErrorMessage } from "../utils";

export type ProgressCallback = (
  done: number,
  total: number,
  currentFile: string,
  action: string
) => void;

export interface SyncOptions {
  /** Which file keys to include; undefined = include all */
  selectedKeys?: Set<string>;
  /** Override per-conflict resolution from settings */
  conflictResolutions?: Map<string, "local" | "remote">;
  /** Optional commit message stored in S3 metadata */
  message?: string;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Returns a backup path like `conflict/Notes/file.conflict-2026-04-30-143022-487-x9k.md`.
 * Includes ms + 3-char random suffix so two conflicts on the same key in the
 * same second don't overwrite each other's backups.
 */
function makeBackupKey(key: string): string {
  const now = new Date();
  const stamp = now.toISOString()
    .slice(0, 19)
    .replace("T", "-")
    .replace(/:/g, "");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  const rand = Math.random().toString(36).slice(2, 5);
  const suffix = `${stamp}-${ms}-${rand}`;
  const dot = key.lastIndexOf(".");
  const backupName = dot === -1
    ? `${key}.conflict-${suffix}`
    : `${key.slice(0, dot)}.conflict-${suffix}${key.slice(dot)}`;
  return `conflict/${backupName}`;
}

function shouldInclude(key: string, opts: SyncOptions): boolean {
  return !opts.selectedKeys || opts.selectedKeys.has(key);
}

function resolveConflict(key: string, opts: SyncOptions): "local" | "remote" {
  // The modal flow populates conflictResolutions; quick-sync pre-filters
  // conflicts out. If we ever land here without a resolution it means a
  // race or a caller bug — refuse rather than silently overwriting either side.
  const res = opts.conflictResolutions?.get(key);
  if (!res) throw new Error(`No conflict resolution provided for ${key}`);
  return res;
}

function emptyStats(): SyncStats {
  return {
    uploaded: 0,
    downloaded: 0,
    deletedFromS3: 0,
    deletedFromLocal: 0,
    conflicts: 0,
    errors: [],
  };
}


// ─── Vault / S3 building blocks ───────────────────────────────────────────────

export async function ensureParentFolder(vault: Vault, filePath: string): Promise<void> {
  assertSafeVaultKey(filePath);
  const parts = filePath.split("/");
  if (parts.length <= 1) return;
  const folderPath = parts.slice(0, -1).join("/");
  if (!(await vault.adapter.exists(folderPath))) {
    await vault.createFolder(folderPath);
  }
}

/** Read fresh mtime/size from the vault's TFile, or `null` if not yet visible. */
function readVaultStat(vault: Vault, key: string): { mtime: number; size: number } | null {
  const file = vault.getAbstractFileByPath(key);
  return file instanceof TFile ? file.stat : null;
}

/** Build a SyncRecord, falling back through fresh stat → change snapshot → defaults. */
function buildSyncRecord(
  vault: Vault,
  change: FileChange,
  etag: string,
  fallbackSize: number,
): SyncRecord {
  const stat = readVaultStat(vault, change.key);
  return {
    key: change.key,
    s3Key: change.s3Key,
    etag,
    localMtime: stat?.mtime ?? change.localMtime ?? Date.now(),
    localSize: stat?.size ?? change.localSize ?? fallbackSize,
    syncTime: Date.now(),
  };
}

async function uploadLocalToS3(
  change: FileChange,
  vault: Vault,
  s3: S3ClientWrapper,
): Promise<string> {
  const data = await vault.adapter.readBinary(change.key);
  return s3.putObject(change.s3Key, data, change.localMtime);
}

async function downloadS3ToLocal(
  change: FileChange,
  vault: Vault,
  s3: S3ClientWrapper,
): Promise<ArrayBuffer> {
  assertSafeVaultKey(change.key);
  const data = await s3.getObject(change.s3Key);
  await ensureParentFolder(vault, change.key);
  await vault.adapter.writeBinary(change.key, data);
  return data;
}

async function trashFile(vault: Vault, key: string): Promise<void> {
  assertSafeVaultKey(key);
  if (!(await vault.adapter.exists(key))) return;
  const trashed = await vault.adapter.trashSystem(key);
  if (!trashed) await vault.adapter.trashLocal(key);
}

async function backupLocalIfExists(vault: Vault, key: string): Promise<void> {
  assertSafeVaultKey(key);
  if (!(await vault.adapter.exists(key))) return;
  const bytes = await vault.adapter.readBinary(key);
  const backupKey = makeBackupKey(key);
  await ensureParentFolder(vault, backupKey);
  await vault.adapter.writeBinary(backupKey, bytes);
}

// ─── Core Executor ────────────────────────────────────────────────────────────

export async function executeSync(
  changes: FileChange[],
  opts: SyncOptions,
  vault: Vault,
  s3: S3ClientWrapper,
  db: LocalDB,
  onProgress?: ProgressCallback,
): Promise<SyncStats> {
  const stats = emptyStats();
  const selected = changes.filter((c) => shouldInclude(c.key, opts));
  const total = selected.length;
  let done = 0;

  const progress = (file: string, action: string) => onProgress?.(done, total, file, action);

  const newRecords: SyncRecord[] = [];
  const fileLog: SyncFileRecord[] = [];

  for (const change of selected) {
    progress(change.key, "starting");

    try {
      switch (change.changeType) {
        case "local_new":
        case "local_modified": {
          progress(change.key, "uploading");
          const etag = await uploadLocalToS3(change, vault, s3);
          newRecords.push(buildSyncRecord(vault, change, etag, 0));
          fileLog.push({ key: change.key, action: "uploaded" });
          stats.uploaded++;
          break;
        }

        case "remote_new":
        case "remote_modified": {
          progress(change.key, "downloading");
          const data = await downloadS3ToLocal(change, vault, s3);
          newRecords.push(buildSyncRecord(vault, change, change.remoteEtag ?? "", data.byteLength));
          fileLog.push({ key: change.key, action: "downloaded" });
          stats.downloaded++;
          break;
        }

        case "local_deleted":
          progress(change.key, "deleting from S3");
          await s3.deleteObject(change.s3Key);
          await db.deleteSyncRecord(change.key);
          fileLog.push({ key: change.key, action: "deleted-s3" });
          stats.deletedFromS3++;
          break;

        case "remote_deleted":
          progress(change.key, "deleting locally");
          await trashFile(vault, change.key);
          await db.deleteSyncRecord(change.key);
          fileLog.push({ key: change.key, action: "deleted-local" });
          stats.deletedFromLocal++;
          break;

        case "conflict": {
          stats.conflicts++;
          if (resolveConflict(change.key, opts) === "local") {
            progress(change.key, "uploading (conflict → local wins)");
            const etag = await uploadLocalToS3(change, vault, s3);
            newRecords.push(buildSyncRecord(vault, change, etag, 0));
            stats.uploaded++;
          } else {
            progress(change.key, "downloading (conflict → remote wins)");
            await backupLocalIfExists(vault, change.key);
            const data = await downloadS3ToLocal(change, vault, s3);
            newRecords.push(buildSyncRecord(vault, change, change.remoteEtag ?? "", data.byteLength));
            stats.downloaded++;
          }
          fileLog.push({ key: change.key, action: "conflict" });
          break;
        }
      }
    } catch (err: unknown) {
      stats.errors.push(`${change.key}: ${extractErrorMessage(err)}`);
    }

    done++;
    progress(change.key, "done");
  }

  await db.bulkUpsertSyncRecords(newRecords);
  await db.addHistoryEntry({
    id: nanoid(),
    time: Date.now(),
    message: opts.message ?? "",
    stats,
    files: fileLog,
  });

  return stats;
}

// ─── Dry-run summary ──────────────────────────────────────────────────────────

type CountField = Exclude<keyof SyncStats, "errors">;

const STATS_FIELD: Record<FileChange["changeType"], CountField> = {
  local_new: "uploaded",
  local_modified: "uploaded",
  remote_new: "downloaded",
  remote_modified: "downloaded",
  local_deleted: "deletedFromS3",
  remote_deleted: "deletedFromLocal",
  conflict: "conflicts",
};

/** Returns what WOULD happen without actually doing it. */
export function dryRunStats(changes: FileChange[], opts: SyncOptions): SyncStats {
  const stats = emptyStats();
  for (const c of changes) {
    if (!shouldInclude(c.key, opts)) continue;
    stats[STATS_FIELD[c.changeType]]++;
  }
  return stats;
}
