import { Platform, type Vault } from "obsidian";
import type { LocalDB } from "./localdb";
import type { S3ClientWrapper } from "../s3/client";
import type { FileChange, RemoteObject, S3GitSyncSettings } from "../types";

// ─── Pattern Matching ─────────────────────────────────────────────────────────

const patternCache = new Map<string, RegExp>();

function matchesPattern(path: string, pattern: string): boolean {
  let re = patternCache.get(pattern);
  if (!re) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    patternCache.set(pattern, re);
  }
  return re.test(path);
}

function isIgnored(path: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(path, p));
}

// ─── Content hashing (S3 ETag compatibility) ─────────────────────────────────
// S3 returns the lowercase hex MD5 of the object body as the ETag for
// single-PUT (non-multipart) uploads. Multipart uploads use a different
// scheme and have a "-N" suffix where N is the part count — we skip those.

function isMultipartEtag(etag: string): boolean {
  return etag.replace(/"/g, "").includes("-");
}

type CryptoModule = {
  createHash: (alg: string) => {
    update: (buf: Uint8Array) => { digest: (enc: string) => string };
  };
};

// Memoised so the module loader is only hit once per session.
let _cryptoCache: CryptoModule | null | undefined;

async function loadCrypto(): Promise<CryptoModule | null> {
  if (_cryptoCache !== undefined) return _cryptoCache;
  // Electron desktop renderer: CommonJS require is on globalThis.
  // eslint-disable-next-line obsidianmd/prefer-active-doc -- accessing Electron's CommonJS require, not the document
  const rq = (globalThis as Record<string, unknown>)["require"];
  if (typeof rq === "function") {
    try { return (_cryptoCache = (rq as (id: string) => unknown)("crypto") as CryptoModule); }
    catch { /* fall through */ }
  }
  // Node ESM (vitest unit tests): `node:*` is external in esbuild so this
  // branch is only reachable in the test runner, never in Obsidian.
  // eslint-disable-next-line obsidianmd/no-nodejs-modules -- desktop-only fallback path; mobile is short-circuited via Platform.isDesktop
  try { return (_cryptoCache = await import("node:crypto") as unknown as CryptoModule); }
  catch { return (_cryptoCache = null); }
}

async function computeMd5Hex(data: ArrayBuffer): Promise<string | null> {
  if (!Platform.isDesktop) return null; // mobile has no Node.js crypto
  const crypto = await loadCrypto();
  if (!crypto) return null;
  try {
    return crypto.createHash("md5").update(new Uint8Array(data)).digest("hex");
  } catch {
    return null;
  }
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
  const ignorePatterns = settings.ignorePatterns;

  const localFiles = vault.getFiles().filter((f) => !isIgnored(f.path, ignorePatterns));
  const localMap = new Map(localFiles.map((f) => [f.path, f]));

  const remoteObjects: RemoteObject[] = await s3.listObjects();
  const remoteMap = new Map(
    remoteObjects.filter((o) => !isIgnored(o.vaultKey, ignorePatterns)).map((o) => [o.vaultKey, o])
  );

  const syncedMap = await db.getAllSyncRecords();

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
      if (!local) {
        if (!remote) {
          // Both sides deleted — clean up the orphaned record
          await db.deleteSyncRecord(key);
          continue;
        }
        // Deleted locally; remote still exists → remove from S3
        changes.push({
          key,
          s3Key,
          changeType: "local_deleted",
          remoteMtime: remote.lastModified,
          remoteSize: remote.size,
          remoteEtag: remote.etag,
        });
        continue;
      }

      if (!remote) {
        // Deleted from S3; local still exists → remove locally
        changes.push({
          key,
          s3Key,
          changeType: "remote_deleted",
          localMtime: local.stat.mtime,
          localSize: local.stat.size,
        });
        continue;
      }

      // Both exist — check if either side changed
      // 1s tolerance on mtime to avoid false positives from filesystem resolution differences
      let localChanged = local.stat.mtime > synced.localMtime + 1000;
      let remoteChanged = remote.etag !== synced.etag;

      // mtime can change without the content changing (e.g. user opened the
      // file, Obsidian re-saved on close, or a file-system tool touched it).
      // If the size is unchanged AND the remote ETag is a plain MD5 (not a
      // multipart hash-of-hashes), verify by hashing the local content. When
      // the hash matches the synced ETag, silently update the record's mtime
      // so we don't keep flagging the same touch on every diff run.
      if (
        localChanged &&
        !remoteChanged &&
        local.stat.size === synced.localSize &&
        !isMultipartEtag(synced.etag)
      ) {
        const data = await vault.adapter.readBinary(local.path);
        const md5 = await computeMd5Hex(data);
        if (md5 && md5 === synced.etag.replace(/"/g, "")) {
          await db.upsertSyncRecord({ ...synced, localMtime: local.stat.mtime });
          localChanged = false;
        }
      }

      // The remote ETag can change without the content changing — e.g. a file
      // re-PUT with the same bytes, a metadata-only update, or SSE key rotation.
      // If the new remote ETag is a plain MD5 and local content hashes to the
      // same value, the two sides are already in sync; just update the record.
      if (
        remoteChanged &&
        !localChanged &&
        remote.size === local.stat.size &&
        !isMultipartEtag(remote.etag)
      ) {
        const data = await vault.adapter.readBinary(local.path);
        const md5 = await computeMd5Hex(data);
        if (md5 && md5 === remote.etag) {
          await db.upsertSyncRecord({ ...synced, etag: remote.etag, localMtime: local.stat.mtime });
          remoteChanged = false;
        }
      }

      if (localChanged && remoteChanged) {
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
      } else if (localChanged) {
        changes.push({
          key,
          s3Key,
          changeType: "local_modified",
          localMtime: local.stat.mtime,
          localSize: local.stat.size,
          remoteMtime: remote.lastModified,
          remoteSize: remote.size,
          remoteEtag: remote.etag,
        });
      } else if (remoteChanged) {
        changes.push({
          key,
          s3Key,
          changeType: "remote_modified",
          localMtime: local.stat.mtime,
          localSize: local.stat.size,
          remoteMtime: remote.lastModified,
          remoteSize: remote.size,
          remoteEtag: remote.etag,
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

  // Stable sort by vault key — byte comparison is sufficient for ASCII-dominant paths.
  changes.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

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
