import localforage from "localforage";
import type { SyncHistoryEntry, SyncRecord } from "../types";

type Store = ReturnType<typeof localforage.createInstance>;

// ─── Store Factories ──────────────────────────────────────────────────────────

const makeRecordsStore = (vaultName: string) =>
  localforage.createInstance({
    name: `s3-git-sync-${vaultName}`,
    storeName: "sync-records",
    description: "Per-file sync state for 3-way diff",
  });

const makeHistoryStore = (vaultName: string) =>
  localforage.createInstance({
    name: `s3-git-sync-${vaultName}`,
    storeName: "sync-history",
    description: "Sync history log",
  });

// ─── Public API ───────────────────────────────────────────────────────────────

export class LocalDB {
  private records: Store;
  private history: Store;

  constructor(vaultName: string) {
    this.records = makeRecordsStore(vaultName);
    this.history = makeHistoryStore(vaultName);
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
