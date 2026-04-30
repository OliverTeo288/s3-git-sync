import type { Vault } from "obsidian";
import type { LocalDB } from "./localdb";
import type { S3ClientWrapper } from "./s3client";
import type { FileChange, RemoteObject, S3Config, S3GitSyncSettings } from "./types";

// ─── Pattern Matching ─────────────────────────────────────────────────────────

function matchesPattern(path: string, pattern: string): boolean {
  // Support simple glob wildcards (* and ?)
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexStr = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regexStr}$`).test(path);
}

function isIgnored(path: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(path, p));
}

// ─── Diff Engine ──────────────────────────────────────────────────────────────

export interface DiffResult {
  changes: FileChange[];
  totalLocal: number;
  totalRemote: number;
}

/**
 * Compute a 3-way diff between:
 *   - Current local vault files
 *   - Current S3 objects
 *   - Last known sync state (from LocalDB)
 *
 * Analogous to `git status` — shows what changed on each side since the last sync.
 */
export async function computeChanges(
  vault: Vault,
  s3: S3ClientWrapper,
  db: LocalDB,
  settings: S3GitSyncSettings
): Promise<DiffResult> {
  const ignorePatterns = settings.ignorePatterns ?? [];

  // 1. Gather local files
  const localFiles = vault.getFiles().filter((f) => !isIgnored(f.path, ignorePatterns));
  const localMap = new Map(localFiles.map((f) => [f.path, f]));

  // 2. Gather remote objects
  const remoteObjects: RemoteObject[] = await s3.listObjects();
  const remoteMap = new Map(
    remoteObjects.filter((o) => !isIgnored(o.vaultKey, ignorePatterns)).map((o) => [o.vaultKey, o])
  );

  // 3. Load last sync records
  const syncedMap = await db.getAllSyncRecords();

  // 4. Build the union of all known keys
  const allKeys = new Set<string>([
    ...localMap.keys(),
    ...remoteMap.keys(),
    ...syncedMap.keys(),
  ]);

  const changes: FileChange[] = [];

  for (const key of allKeys) {
    const local = localMap.get(key);
    const remote = remoteMap.get(key);
    const synced = syncedMap.get(key);

    const s3Key = s3.vaultKeyToS3Key(key);

    if (synced) {
      // ── We've synced this file before ──────────────────────────────────────
      const localMissing = !local;
      const remoteMissing = !remote;

      if (localMissing && remoteMissing) {
        // Both sides deleted — clean up the orphaned record
        await db.deleteSyncRecord(key);
        continue;
      }

      if (localMissing) {
        // Deleted locally; remote still exists → remove from S3
        changes.push({
          key,
          s3Key,
          changeType: "local_deleted",
          remoteMtime: remote!.lastModified,
          remoteSize: remote!.size,
          remoteEtag: remote!.etag,
        });
        continue;
      }

      if (remoteMissing) {
        // Deleted from S3; local still exists → remove locally
        changes.push({
          key,
          s3Key,
          changeType: "remote_deleted",
          localMtime: local!.stat.mtime,
          localSize: local!.stat.size,
        });
        continue;
      }

      // Both exist — check if either side changed
      // 1s tolerance on mtime to avoid false positives from filesystem resolution differences
      const localChanged = local!.stat.mtime > synced.localMtime + 1000;
      const remoteChanged = remote!.etag !== synced.etag;

      if (localChanged && remoteChanged) {
        changes.push({
          key,
          s3Key,
          changeType: "conflict",
          localMtime: local!.stat.mtime,
          localSize: local!.stat.size,
          remoteMtime: remote!.lastModified,
          remoteSize: remote!.size,
          remoteEtag: remote!.etag,
        });
      } else if (localChanged) {
        changes.push({
          key,
          s3Key,
          changeType: "local_modified",
          localMtime: local!.stat.mtime,
          localSize: local!.stat.size,
          remoteMtime: remote!.lastModified,
          remoteSize: remote!.size,
          remoteEtag: remote!.etag,
        });
      } else if (remoteChanged) {
        changes.push({
          key,
          s3Key,
          changeType: "remote_modified",
          localMtime: local!.stat.mtime,
          localSize: local!.stat.size,
          remoteMtime: remote!.lastModified,
          remoteSize: remote!.size,
          remoteEtag: remote!.etag,
        });
      }
      // else: identical on both sides → nothing to do
    } else {
      // ── Never synced this key ──────────────────────────────────────────────
      if (local && !remote) {
        changes.push({
          key,
          s3Key,
          changeType: "local_new",
          localMtime: local.stat.mtime,
          localSize: local.stat.size,
        });
      } else if (!local && remote) {
        changes.push({
          key,
          s3Key,
          changeType: "remote_new",
          remoteMtime: remote.lastModified,
          remoteSize: remote.size,
          remoteEtag: remote.etag,
        });
      } else if (local && remote) {
        // Both exist but we've never synced — treat as conflict
        changes.push({
          key,
          s3Key,
          changeType: "conflict",
          localMtime: local.stat.mtime,
          localSize: local.stat.size,
          remoteMtime: remote.lastModified,
          remoteSize: remote.size,
          remoteEtag: remote.etag,
        });
      }
    }
  }

  // Sort for stable, predictable ordering
  changes.sort((a, b) => a.key.localeCompare(b.key));

  return {
    changes,
    totalLocal: localMap.size,
    totalRemote: remoteMap.size,
  };
}

// ─── Summary helpers ──────────────────────────────────────────────────────────

export interface ChangeSummary {
  localNew: FileChange[];
  localModified: FileChange[];
  localDeleted: FileChange[];
  remoteNew: FileChange[];
  remoteModified: FileChange[];
  remoteDeleted: FileChange[];
  conflicts: FileChange[];
}

export function groupChanges(changes: FileChange[]): ChangeSummary {
  return {
    localNew: changes.filter((c) => c.changeType === "local_new"),
    localModified: changes.filter((c) => c.changeType === "local_modified"),
    localDeleted: changes.filter((c) => c.changeType === "local_deleted"),
    remoteNew: changes.filter((c) => c.changeType === "remote_new"),
    remoteModified: changes.filter((c) => c.changeType === "remote_modified"),
    remoteDeleted: changes.filter((c) => c.changeType === "remote_deleted"),
    conflicts: changes.filter((c) => c.changeType === "conflict"),
  };
}

export function hasChanges(changes: FileChange[]): boolean {
  return changes.length > 0;
}
