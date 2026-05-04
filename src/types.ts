// ─── S3 Authentication ────────────────────────────────────────────────────────

/**
 * "static"  — explicit Access Key ID + Secret Access Key stored in plugin settings.
 *             Simplest to configure; credentials live in data.json (Obsidian-encrypted at rest).
 *
 * "profile" — reads a named profile from the OS AWS credential chain
 *             (~/.aws/credentials + ~/.aws/config). Credentials are never stored in the
 *             plugin. Only available on desktop; disabled on mobile.
 */
export type AuthMethod = "static" | "profile";

// ─── S3 Configuration ────────────────────────────────────────────────────────

export interface S3Config {
  authMethod: AuthMethod;

  // ── Static credentials (authMethod === "static") ───────────────────────────
  s3AccessKeyID: string;
  s3SecretAccessKey: string;

  // ── Profile credentials (authMethod === "profile") ─────────────────────────
  /** Named AWS profile from ~/.aws/credentials. Defaults to "default". */
  s3ProfileName: string;

  // ── Common ─────────────────────────────────────────────────────────────────
  s3Endpoint: string;
  s3Region: string;
  s3BucketName: string;
  /** Remote key prefix, e.g. "my-vault/" — acts like a "branch". */
  s3Prefix: string;
  /** Required for MinIO / self-hosted S3 implementations. */
  forcePathStyle: boolean;
}

export const DEFAULT_S3_CONFIG: S3Config = {
  authMethod: "static",
  s3AccessKeyID: "",
  s3SecretAccessKey: "",
  s3ProfileName: "default",
  s3Endpoint: "",
  s3Region: "us-east-1",
  s3BucketName: "",
  s3Prefix: "",
  forcePathStyle: false,
};

// ─── Plugin Settings ──────────────────────────────────────────────────────────

export interface S3GitSyncSettings {
  s3: S3Config;
  ignorePatterns: string[];        // glob-like patterns to exclude
  showStatusBar: boolean;
  /** How often to poll S3 for remote changes and update the ribbon badge (minutes). 0 = disabled. */
  badgePollIntervalMin: number;
}

export const DEFAULT_SETTINGS: S3GitSyncSettings = {
  s3: DEFAULT_S3_CONFIG,
  // workspace files are populated dynamically from Vault.configDir at plugin load time
  ignorePatterns: ["conflict/*"],
  showStatusBar: true,
  badgePollIntervalMin: 5,
};

// ─── S3 Object Version ────────────────────────────────────────────────────────

export interface ObjectVersion {
  versionId: string;
  lastModified: Date;
  size: number;
  etag: string;
  isLatest: boolean;
}

// ─── Remote Object Descriptor ────────────────────────────────────────────────

export interface RemoteObject {
  /** vault-relative path, e.g. "Notes/Hello.md" */
  vaultKey: string;
  /** full S3 key including prefix */
  s3Key: string;
  etag: string;
  lastModified: Date;
  size: number;
}

// ─── Sync State Record (persisted in LocalForage) ────────────────────────────

/** Snapshot of a file at the time it was last successfully synced */
export interface SyncRecord {
  /** vault-relative path */
  key: string;
  /** full S3 key with prefix at time of sync */
  s3Key: string;
  /** S3 ETag at last sync */
  etag: string;
  /** local file mtime (ms) at last sync */
  localMtime: number;
  /** local file size (bytes) at last sync */
  localSize: number;
  /** unix ms when the sync happened */
  syncTime: number;
}

// ─── Change Types ─────────────────────────────────────────────────────────────

export type ChangeType =
  | "local_new"        // exists locally, not on S3, not previously synced → upload
  | "local_modified"   // exists both places, local is newer → upload
  | "local_deleted"    // was synced, now missing locally, still on S3 → delete from S3
  | "remote_new"       // exists on S3, not locally, not previously synced → download
  | "remote_modified"  // exists both places, remote etag changed → download
  | "remote_deleted"   // was synced, now missing from S3, still local → delete locally
  | "conflict";        // both sides changed since last sync

export interface FileChange {
  /** vault-relative path */
  key: string;
  /** full S3 key */
  s3Key: string;
  changeType: ChangeType;
  /** populated when local file exists */
  localMtime?: number;
  localSize?: number;
  /** populated when remote object exists */
  remoteMtime?: Date;
  remoteSize?: number;
  remoteEtag?: string;
  /** for conflicts: which resolution was chosen */
  conflictResolution?: "local" | "remote";
}

// ─── Sync Stats ───────────────────────────────────────────────────────────────

export interface SyncStats {
  uploaded: number;
  downloaded: number;
  deletedFromS3: number;
  deletedFromLocal: number;
  conflicts: number;
  errors: string[];
}

// ─── Sync History Entry (persisted in LocalForage) ───────────────────────────

export interface SyncFileRecord {
  key: string;
  action: "uploaded" | "downloaded" | "deleted-s3" | "deleted-local" | "conflict";
}

export interface SyncHistoryEntry {
  id: string;
  time: number;
  message: string;
  stats: SyncStats;
  /** Per-file log for the "expand files" view in History modal. Optional for backwards compat. */
  files?: SyncFileRecord[];
}
