import { nanoid } from "nanoid";
import type { Vault } from "obsidian";
import type { LocalDB } from "./localdb";
import type { S3ClientWrapper } from "./s3client";
import type {
  FileChange,
  SyncFileRecord,
  SyncRecord,
  SyncStats,
} from "./types";

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns a backup path like `conflict/Notes/file.conflict-2026-04-30-143022.md` */
function makeBackupKey(key: string): string {
  const now = new Date();
  const stamp = now.toISOString()
    .slice(0, 19)           // "2026-04-30T14:30:22"
    .replace("T", "-")      // "2026-04-30-14:30:22"
    .replace(/:/g, "");     // "2026-04-30-143022"
  const dot = key.lastIndexOf(".");
  const backupName = dot === -1
    ? `${key}.conflict-${stamp}`
    : `${key.slice(0, dot)}.conflict-${stamp}${key.slice(dot)}`;
  return `conflict/${backupName}`;
}

function shouldInclude(key: string, opts: SyncOptions): boolean {
  if (!opts.selectedKeys) return true;
  return opts.selectedKeys.has(key);
}

function resolveConflict(key: string, opts: SyncOptions): "local" | "remote" {
  // Always use the per-file resolution set in the change-view modal.
  // Quick sync / auto sync pre-filter conflicts out before calling executeSync,
  // so this path is only reached via the modal which always populates the map.
  return opts.conflictResolutions?.get(key) ?? "local";
}

// ─── Core Executor ────────────────────────────────────────────────────────────

export async function executeSync(
  changes: FileChange[],
  opts: SyncOptions,
  vault: Vault,
  s3: S3ClientWrapper,
  db: LocalDB,
  onProgress?: ProgressCallback
): Promise<SyncStats> {
  const stats: SyncStats = {
    uploaded: 0,
    downloaded: 0,
    deletedFromS3: 0,
    deletedFromLocal: 0,
    conflicts: 0,
    errors: [],
  };

  const selected = changes.filter((c) => shouldInclude(c.key, opts));
  const total = selected.length;
  let done = 0;

  const progress = (file: string, action: string) => {
    onProgress?.(done, total, file, action);
  };

  const newRecords: SyncRecord[] = [];
  const fileLog: SyncFileRecord[] = [];

  for (const change of selected) {
    progress(change.key, "starting");

    try {
      switch (change.changeType) {
        // ── Upload local → S3 ─────────────────────────────────────────────────
        case "local_new":
        case "local_modified": {
          progress(change.key, "uploading");
          const data = await vault.adapter.readBinary(change.key);
          const etag = await s3.putObject(change.s3Key, data, change.localMtime);
          const file = vault.getAbstractFileByPath(change.key);
          const mtime = (file as any)?.stat?.mtime ?? change.localMtime ?? Date.now();
          const size = (file as any)?.stat?.size ?? change.localSize ?? data.byteLength;
          newRecords.push({
            key: change.key,
            s3Key: change.s3Key,
            etag,
            localMtime: mtime,
            localSize: size,
            syncTime: Date.now(),
          });
          fileLog.push({ key: change.key, action: "uploaded" });
          stats.uploaded++;
          break;
        }

        // ── Download S3 → local ───────────────────────────────────────────────
        case "remote_new":
        case "remote_modified": {
          progress(change.key, "downloading");
          const data = await s3.getObject(change.s3Key);
          await ensureParentFolder(vault, change.key);
          await vault.adapter.writeBinary(change.key, data);
          const file = vault.getAbstractFileByPath(change.key);
          const mtime = (file as any)?.stat?.mtime ?? Date.now();
          const size = (file as any)?.stat?.size ?? data.byteLength;
          newRecords.push({
            key: change.key,
            s3Key: change.s3Key,
            etag: change.remoteEtag ?? "",
            localMtime: mtime,
            localSize: size,
            syncTime: Date.now(),
          });
          fileLog.push({ key: change.key, action: "downloaded" });
          stats.downloaded++;
          break;
        }

        // ── Delete from S3 (locally deleted) ──────────────────────────────────
        case "local_deleted": {
          progress(change.key, "deleting from S3");
          await s3.deleteObject(change.s3Key);
          await db.deleteSyncRecord(change.key);
          fileLog.push({ key: change.key, action: "deleted-s3" });
          stats.deletedFromS3++;
          break;
        }

        // ── Delete from local (remotely deleted) ──────────────────────────────
        case "remote_deleted": {
          progress(change.key, "deleting locally");
          const fileExists = await vault.adapter.exists(change.key);
          if (fileExists) {
            const trashed = await vault.adapter.trashSystem(change.key);
            if (!trashed) await vault.adapter.trashLocal(change.key);
          }
          await db.deleteSyncRecord(change.key);
          fileLog.push({ key: change.key, action: "deleted-local" });
          stats.deletedFromLocal++;
          break;
        }

        // ── Conflict resolution ───────────────────────────────────────────────
        case "conflict": {
          stats.conflicts++;
          const resolution = resolveConflict(change.key, opts);

          if (resolution === "local") {
            progress(change.key, "uploading (conflict → local wins)");
            const data = await vault.adapter.readBinary(change.key);
            const etag = await s3.putObject(change.s3Key, data, change.localMtime);
            const file = vault.getAbstractFileByPath(change.key);
            newRecords.push({
              key: change.key,
              s3Key: change.s3Key,
              etag,
              localMtime: (file as any)?.stat?.mtime ?? change.localMtime ?? Date.now(),
              localSize: (file as any)?.stat?.size ?? change.localSize ?? data.byteLength,
              syncTime: Date.now(),
            });
            fileLog.push({ key: change.key, action: "conflict" });
            stats.uploaded++;
          } else {
            progress(change.key, "downloading (conflict → remote wins)");

            // Save local copy as a backup before overwriting
            const localExists = await vault.adapter.exists(change.key);
            if (localExists) {
              const localBytes = await vault.adapter.readBinary(change.key);
              const backupKey = makeBackupKey(change.key);
              await ensureParentFolder(vault, backupKey);
              await vault.adapter.writeBinary(backupKey, localBytes);
            }
            const data = await s3.getObject(change.s3Key);
            await ensureParentFolder(vault, change.key);
            await vault.adapter.writeBinary(change.key, data);
            const file = vault.getAbstractFileByPath(change.key);
            newRecords.push({
              key: change.key,
              s3Key: change.s3Key,
              etag: change.remoteEtag ?? "",
              localMtime: (file as any)?.stat?.mtime ?? Date.now(),
              localSize: (file as any)?.stat?.size ?? data.byteLength,
              syncTime: Date.now(),
            });
            fileLog.push({ key: change.key, action: "conflict" });
            stats.downloaded++;
          }
          break;
        }
      }
    } catch (err: any) {
      stats.errors.push(`${change.key}: ${err?.message ?? String(err)}`);
    }

    done++;
    progress(change.key, "done");
  }

  // Persist sync records for successfully processed files
  await db.bulkUpsertSyncRecords(newRecords);

  // Write sync history entry
  await db.addHistoryEntry({
    id: nanoid(),
    time: Date.now(),
    message: opts.message ?? "",
    stats,
    files: fileLog,
  });

  return stats;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

async function ensureParentFolder(vault: Vault, filePath: string): Promise<void> {
  const parts = filePath.split("/");
  if (parts.length <= 1) return;
  const folderPath = parts.slice(0, -1).join("/");
  if (!(await vault.adapter.exists(folderPath))) {
    await vault.createFolder(folderPath);
  }
}

// ─── Dry-run summary ──────────────────────────────────────────────────────────

/** Returns what WOULD happen without actually doing it */
export function dryRunStats(changes: FileChange[], opts: SyncOptions): SyncStats {
  const stats: SyncStats = {
    uploaded: 0,
    downloaded: 0,
    deletedFromS3: 0,
    deletedFromLocal: 0,
    conflicts: 0,
    errors: [],
  };

  for (const c of changes) {
    if (!shouldInclude(c.key, opts)) continue;
    switch (c.changeType) {
      case "local_new":
      case "local_modified":
        stats.uploaded++;
        break;
      case "remote_new":
      case "remote_modified":
        stats.downloaded++;
        break;
      case "local_deleted":
        stats.deletedFromS3++;
        break;
      case "remote_deleted":
        stats.deletedFromLocal++;
        break;
      case "conflict":
        stats.conflicts++;
        break;
    }
  }

  return stats;
}
