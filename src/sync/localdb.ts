import localforage from "localforage";
import type { SyncHistoryEntry, SyncRecord } from "../types";

type Store = ReturnType<typeof localforage.createInstance>;

// ─── Store Factories ──────────────────────────────────────────────────────────

const makeRecordsStore = (vaultName: string) =>
  localforage.createInstance({
    name: `s-three-sync-${vaultName}`,
    storeName: "sync-records",
    description: "Per-file sync state for 3-way diff",
  });

const makeHistoryStore = (vaultName: string) =>
  localforage.createInstance({
    name: `s-three-sync-${vaultName}`,
    storeName: "sync-history",
    description: "Sync history log",
  });

// ─── Legacy migration ─────────────────────────────────────────────────────────

/**
 * One-time migration: copy records from the old `s3-git-sync-*` IndexedDB
 * stores (used before the plugin was renamed to s-three-sync) into the current
 * `s-three-sync-*` stores.  Only runs when the new store is empty — i.e. on
 * the first load after an upgrade.  After copying, the old stores are cleared
 * so the migration never runs again.
 */
async function migrateFromLegacyStores(
  vaultName: string,
  newRecords: Store,
  newHistory: Store,
): Promise<void> {
  const newRecordCount = await newRecords.length();
  if (newRecordCount > 0) return; // already populated — nothing to do

  const legacyRecords = localforage.createInstance({
    name: `s3-git-sync-${vaultName}`,
    storeName: "sync-records",
  });
  const legacyHistory = localforage.createInstance({
    name: `s3-git-sync-${vaultName}`,
    storeName: "sync-history",
  });

  const legacyCount = await legacyRecords.length();
  if (legacyCount === 0) return; // no legacy data to migrate

  // Copy records
  await legacyRecords.iterate<SyncRecord, void>(async (value, key) => {
    await newRecords.setItem(key, value);
  });

  // Copy history
  await legacyHistory.iterate<SyncHistoryEntry, void>(async (value, key) => {
    await newHistory.setItem(key, value);
  });

  // Clear legacy stores so this branch is never entered again
  await Promise.all([legacyRecords.clear(), legacyHistory.clear()]);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export class LocalDB {
  private records: Store;
  private history: Store;

  constructor(vaultName: string) {
    this.records = makeRecordsStore(vaultName);
    this.history = makeHistoryStore(vaultName);
  }

  /** Must be awaited once after construction before any reads/writes. */
  async init(vaultName: string): Promise<void> {
    await migrateFromLegacyStores(vaultName, this.records, this.history);
  }

  // ── Sync Records ────────────────────────────────────────────────────────────

  async getSyncRecord(key: string): Promise<SyncRecord | null> {
    return this.records.getItem<SyncRecord>(key);
  }

  async getAllSyncRecords(): Promise<Map<string, SyncRecord>> {
    const map = new Map<string, SyncRecord>();
    await this.records.iterate<SyncRecord, void>((value, key) => {
      map.set(key, value);
    });
    return map;
  }

  async upsertSyncRecord(record: SyncRecord): Promise<void> {
    await this.records.setItem(record.key, record);
  }

  async deleteSyncRecord(key: string): Promise<void> {
    await this.records.removeItem(key);
  }

  /** Bulk-upsert after a successful sync */
  async bulkUpsertSyncRecords(records: SyncRecord[]): Promise<void> {
    await Promise.all(records.map((r) => this.records.setItem(r.key, r)));
  }

  async clearAllSyncRecords(): Promise<void> {
    await this.records.clear();
  }

  // ── Sync History ────────────────────────────────────────────────────────────

  /** Returns entries newest-first */
  async getHistory(limit = 50): Promise<SyncHistoryEntry[]> {
    const entries: SyncHistoryEntry[] = [];
    await this.history.iterate<SyncHistoryEntry, void>((value) => {
      entries.push(value);
    });
    entries.sort((a, b) => b.time - a.time);
    return entries.slice(0, limit);
  }

  async addHistoryEntry(entry: SyncHistoryEntry): Promise<void> {
    await this.history.setItem(entry.id, entry);
    await this.pruneHistory(100);
  }

  private async pruneHistory(maxEntries: number): Promise<void> {
    const entries = await this.getHistory(Number.MAX_SAFE_INTEGER);
    if (entries.length <= maxEntries) return;
    const toDelete = entries.slice(maxEntries);
    await Promise.all(toDelete.map((e) => this.history.removeItem(e.id)));
  }
}
