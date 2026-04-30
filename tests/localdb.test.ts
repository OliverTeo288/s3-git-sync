import { describe, it, expect, beforeEach } from "vitest";
import { LocalDB } from "../src/localdb";
import type { SyncRecord, SyncHistoryEntry } from "../src/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRecord(key: string, overrides: Partial<SyncRecord> = {}): SyncRecord {
  return {
    key,
    s3Key: key,
    etag: "abc123",
    localMtime: 1_000_000,
    localSize: 512,
    syncTime: 900_000,
    ...overrides,
  };
}

function makeEntry(id: string, time: number): SyncHistoryEntry {
  return {
    id,
    time,
    message: `sync ${id}`,
    stats: {
      uploaded: 1,
      downloaded: 0,
      deletedFromS3: 0,
      deletedFromLocal: 0,
      conflicts: 0,
      errors: [],
    },
  };
}

// ─── Sync Records ─────────────────────────────────────────────────────────────

describe("LocalDB — sync records", () => {
  let db: LocalDB;

  beforeEach(() => {
    db = new LocalDB("test-vault");
  });

  it("returns null for a key that was never stored", async () => {
    expect(await db.getSyncRecord("missing.md")).toBeNull();
  });

  it("stores and retrieves a sync record", async () => {
    const rec = makeRecord("Notes/hello.md");
    await db.upsertSyncRecord(rec);
    expect(await db.getSyncRecord("Notes/hello.md")).toEqual(rec);
  });

  it("overwrites an existing record on upsert", async () => {
    await db.upsertSyncRecord(makeRecord("a.md", { etag: "old" }));
    await db.upsertSyncRecord(makeRecord("a.md", { etag: "new" }));
    const result = await db.getSyncRecord("a.md");
    expect(result?.etag).toBe("new");
  });

  it("deletes a record", async () => {
    await db.upsertSyncRecord(makeRecord("b.md"));
    await db.deleteSyncRecord("b.md");
    expect(await db.getSyncRecord("b.md")).toBeNull();
  });

  it("getAllSyncRecords returns all stored records as a Map", async () => {
    await db.upsertSyncRecord(makeRecord("a.md"));
    await db.upsertSyncRecord(makeRecord("b.md"));
    const map = await db.getAllSyncRecords();
    expect(map.size).toBe(2);
    expect(map.has("a.md")).toBe(true);
    expect(map.has("b.md")).toBe(true);
  });

  it("getAllSyncRecords returns empty Map when nothing stored", async () => {
    const map = await db.getAllSyncRecords();
    expect(map.size).toBe(0);
  });

  it("bulkUpsertSyncRecords stores all records in parallel", async () => {
    const records = ["a.md", "b.md", "c.md"].map((k) => makeRecord(k));
    await db.bulkUpsertSyncRecords(records);
    const map = await db.getAllSyncRecords();
    expect(map.size).toBe(3);
  });

  it("clearAllSyncRecords removes everything", async () => {
    await db.upsertSyncRecord(makeRecord("a.md"));
    await db.upsertSyncRecord(makeRecord("b.md"));
    await db.clearAllSyncRecords();
    const map = await db.getAllSyncRecords();
    expect(map.size).toBe(0);
  });
});

// ─── Sync History ─────────────────────────────────────────────────────────────

describe("LocalDB — sync history", () => {
  let db: LocalDB;

  beforeEach(() => {
    db = new LocalDB("test-vault");
  });

  it("returns empty array when no history exists", async () => {
    expect(await db.getHistory()).toEqual([]);
  });

  it("stores and retrieves a history entry", async () => {
    const entry = makeEntry("e1", 1000);
    await db.addHistoryEntry(entry);
    const history = await db.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe("e1");
  });

  it("returns entries sorted newest-first", async () => {
    await db.addHistoryEntry(makeEntry("old", 1000));
    await db.addHistoryEntry(makeEntry("new", 3000));
    await db.addHistoryEntry(makeEntry("mid", 2000));
    const history = await db.getHistory();
    expect(history.map((e) => e.id)).toEqual(["new", "mid", "old"]);
  });

  it("respects the limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      await db.addHistoryEntry(makeEntry(`e${i}`, i * 1000));
    }
    const history = await db.getHistory(3);
    expect(history).toHaveLength(3);
  });

  it("defaults to returning at most 50 entries", async () => {
    for (let i = 0; i < 60; i++) {
      await db.addHistoryEntry(makeEntry(`e${i}`, i * 1000));
    }
    const history = await db.getHistory();
    expect(history).toHaveLength(50);
  });

  it("prunes history to 100 entries after exceeding the limit", async () => {
    for (let i = 0; i < 105; i++) {
      await db.addHistoryEntry(makeEntry(`e${i}`, i * 1000));
    }
    // pruneHistory keeps 100; getHistory(Infinity) should return 100
    const all = await db.getHistory(Number.MAX_SAFE_INTEGER);
    expect(all.length).toBeLessThanOrEqual(100);
  });
});
