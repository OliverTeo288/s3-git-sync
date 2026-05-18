import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { SyncHistoryEntry, SyncRecord } from "../types";

// ─── DB schema ────────────────────────────────────────────────────────────────

interface VaultDBSchema extends DBSchema {
  "sync-records": { key: string; value: SyncRecord };
  "sync-history": { key: string; value: SyncHistoryEntry };
}

type VaultDB = IDBPDatabase<VaultDBSchema>;

const DB_VERSION = 1;
const DB_PREFIX = "s-three-sync";
const LEGACY_PREFIX = "s3-git-sync";
const STORE_RECORDS = "sync-records" as const;
const STORE_HISTORY = "sync-history" as const;

function openVaultDB(vaultName: string): Promise<VaultDB> {
  return openDB<VaultDBSchema>(`${DB_PREFIX}-${vaultName}`, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_RECORDS)) db.createObjectStore(STORE_RECORDS);
      if (!db.objectStoreNames.contains(STORE_HISTORY)) db.createObjectStore(STORE_HISTORY);
    },
  });
}

// ─── Legacy migration ─────────────────────────────────────────────────────────

/**
 * Copy all entries from one store in the legacy (untyped) DB into the new
 * typed VaultDB. No-ops if the source store is empty.
 */
async function bulkCopyToStore(
  src: IDBPDatabase,
  dst: VaultDB,
  storeName: typeof STORE_RECORDS | typeof STORE_HISTORY,
): Promise<void> {
  const [keys, values] = await Promise.all([src.getAllKeys(storeName), src.getAll(storeName)]);
  if (keys.length === 0) return;
  const tx = dst.transaction(storeName, "readwrite");
  await Promise.all([...keys.map((k, i) => tx.store.put(values[i], k as string)), tx.done]);
}

/**
 * One-time migration: copy records from the old localforage-based database
 * (`s3-git-sync-*`) into the current idb database (`s-three-sync-*`).
 *
 * Only runs when the new database is empty — i.e. on the first load after a
 * plugin rename or idb migration. After copying, the old stores are cleared so
 * this branch is never entered again.
 */
async function migrateFromLegacyDB(vaultName: string, newDb: VaultDB): Promise<void> {
  // Skip if the new DB already has data (migration already ran, or fresh install).
  const count = await newDb.count(STORE_RECORDS);
  if (count > 0) return;

  const legacyName = `${LEGACY_PREFIX}-${vaultName}`;

  // Check whether the legacy database actually exists before trying to open it.
  // indexedDB.databases() is available in all Electron / modern browser versions
  // Obsidian targets; skip migration silently if unavailable.
  try {
    if (typeof indexedDB.databases === "function") {
      const existing = await indexedDB.databases();
      if (!existing.some((d) => d.name === legacyName)) return;
    }
  } catch {
    return; // Defensive: if the check itself fails, skip migration
  }

  // Open the legacy DB. localforage used IDB version 2 for its stores.
  // We do NOT provide an upgrade callback so we never alter the legacy schema.
  const legacy = await openDB(legacyName, 2).catch(() => null);
  if (!legacy) return;

  const storeNames = Array.from(legacy.objectStoreNames);
  if (!storeNames.includes(STORE_RECORDS)) {
    legacy.close();
    return;
  }

  await bulkCopyToStore(legacy, newDb, STORE_RECORDS);
  await legacy.clear(STORE_RECORDS);

  if (storeNames.includes(STORE_HISTORY)) {
    await bulkCopyToStore(legacy, newDb, STORE_HISTORY);
    await legacy.clear(STORE_HISTORY);
  }

  legacy.close();
}

// ─── Public API ───────────────────────────────────────────────────────────────

export class LocalDB {
  private constructor(private readonly db: VaultDB) {}

  /**
   * Open (or create) the vault database and run the one-time legacy migration.
   * Must be awaited before any reads or writes.
   */
  static async create(vaultName: string): Promise<LocalDB> {
    const db = await openVaultDB(vaultName);
    await migrateFromLegacyDB(vaultName, db);
    return new LocalDB(db);
  }

  // ── Sync Records ────────────────────────────────────────────────────────────

  async getSyncRecord(key: string): Promise<SyncRecord | null> {
    return (await this.db.get(STORE_RECORDS, key)) ?? null;
  }

  async getAllSyncRecords(): Promise<Map<string, SyncRecord>> {
    const values = await this.db.getAll(STORE_RECORDS);
    return new Map(values.map((v) => [v.key, v]));
  }

  async upsertSyncRecord(record: SyncRecord): Promise<void> {
    await this.db.put(STORE_RECORDS, record, record.key);
  }

  async deleteSyncRecord(key: string): Promise<void> {
    await this.db.delete(STORE_RECORDS, key);
  }

  /** Bulk-upsert after a successful sync. */
  async bulkUpsertSyncRecords(records: SyncRecord[]): Promise<void> {
    if (records.length === 0) return;
    const tx = this.db.transaction(STORE_RECORDS, "readwrite");
    await Promise.all([...records.map((r) => tx.store.put(r, r.key)), tx.done]);
  }

  async clearAllSyncRecords(): Promise<void> {
    await this.db.clear(STORE_RECORDS);
  }

  // ── Sync History ────────────────────────────────────────────────────────────

  /** Returns entries newest-first. */
  async getHistory(limit = 50): Promise<SyncHistoryEntry[]> {
    const all = await this.db.getAll(STORE_HISTORY);
    return all.sort((a, b) => b.time - a.time).slice(0, limit);
  }

  async addHistoryEntry(entry: SyncHistoryEntry): Promise<void> {
    await this.db.put(STORE_HISTORY, entry, entry.id);
    await this.pruneHistory(100);
  }

  private async pruneHistory(maxEntries: number): Promise<void> {
    // Count first — avoids a full read on the common path where no pruning is needed.
    const total = await this.db.count(STORE_HISTORY);
    if (total <= maxEntries) return;
    const all = await this.db.getAll(STORE_HISTORY);
    all.sort((a, b) => b.time - a.time);
    const toDelete = all.slice(maxEntries);
    const tx = this.db.transaction(STORE_HISTORY, "readwrite");
    await Promise.all([...toDelete.map((e) => tx.store.delete(e.id)), tx.done]);
  }
}
