import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeChanges, groupChanges, hasChanges } from "../src/differ";
import { DEFAULT_SETTINGS } from "../src/types";
import type { RemoteObject, SyncRecord } from "../src/types";

// ─── Mock factories ───────────────────────────────────────────────────────────

type MockFile = { path: string; mtime: number; size: number };

function mockVault(files: MockFile[]) {
  return {
    getFiles: () =>
      files.map((f) => ({
        path: f.path,
        stat: { mtime: f.mtime, size: f.size },
      })),
    adapter: {
      // Return distinct bytes per call so the differ's MD5 check never
      // matches a fake etag (the etags in these tests are strings like
      // "etag1", not real MD5 hashes).
      readBinary: async () => new TextEncoder().encode(`mock-${Math.random()}`).buffer,
    },
  } as any;
}

function mockS3(objects: Omit<RemoteObject, "s3Key">[], prefix = "") {
  return {
    listObjects: async () =>
      objects.map((o) => ({
        ...o,
        s3Key: `${prefix}${o.vaultKey}`,
      })),
    vaultKeyToS3Key: (key: string) => `${prefix}${key}`,
  } as any;
}

function mockDB(records: SyncRecord[] = []) {
  const deleteSyncRecord = vi.fn(async () => {});
  const upsertSyncRecord = vi.fn(async () => {});
  return {
    getAllSyncRecords: async () => new Map(records.map((r) => [r.key, r])),
    deleteSyncRecord,
    upsertSyncRecord,
    _deleteMock: deleteSyncRecord,
    _upsertMock: upsertSyncRecord,
  } as any;
}

function makeSyncRecord(overrides: Partial<SyncRecord> = {}): SyncRecord {
  return {
    key: "Notes/file.md",
    s3Key: "Notes/file.md",
    etag: "abc123",
    localMtime: 1_000_000,
    localSize: 512,
    syncTime: 900_000,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("computeChanges — no prior sync state", () => {
  it("detects local_new: file only on local, never synced", async () => {
    const vault = mockVault([{ path: "Notes/hello.md", mtime: 1_000, size: 100 }]);
    const s3 = mockS3([]);
    const db = mockDB();

    const { changes } = await computeChanges(vault, s3, db, DEFAULT_SETTINGS);

    expect(changes).toHaveLength(1);
    const c = changes[0];
    expect(c.changeType).toBe("local_new");
    expect(c.key).toBe("Notes/hello.md");
    expect(c.localSize).toBe(100);
  });

  it("detects remote_new: object only on S3, never synced", async () => {
    const vault = mockVault([]);
    const s3 = mockS3([
      {
        vaultKey: "Archive/old.md",
        etag: "deadbeef",
        lastModified: new Date(2_000),
        size: 200,
      },
    ]);
    const db = mockDB();

    const { changes } = await computeChanges(vault, s3, db, DEFAULT_SETTINGS);

    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe("remote_new");
    expect(changes[0].key).toBe("Archive/old.md");
  });

  it("treats file on both sides (never synced) as conflict", async () => {
    const vault = mockVault([{ path: "Notes/shared.md", mtime: 5_000, size: 300 }]);
    const s3 = mockS3([
      {
        vaultKey: "Notes/shared.md",
        etag: "xyz",
        lastModified: new Date(6_000),
        size: 350,
      },
    ]);
    const db = mockDB();

    const { changes } = await computeChanges(vault, s3, db, DEFAULT_SETTINGS);

    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe("conflict");
  });

  it("returns empty when vault and S3 are both empty", async () => {
    const { changes } = await computeChanges(
      mockVault([]),
      mockS3([]),
      mockDB(),
      DEFAULT_SETTINGS
    );
    expect(changes).toHaveLength(0);
  });
});

describe("computeChanges — with prior sync state", () => {
  it("returns no changes when local mtime and remote etag are unchanged", async () => {
    const rec = makeSyncRecord({ key: "a.md", etag: "etag1", localMtime: 1_000 });
    const vault = mockVault([{ path: "a.md", mtime: 1_000, size: 512 }]);
    const s3 = mockS3([
      { vaultKey: "a.md", etag: "etag1", lastModified: new Date(500), size: 512 },
    ]);
    const db = mockDB([rec]);

    const { changes } = await computeChanges(vault, s3, db, DEFAULT_SETTINGS);
    expect(changes).toHaveLength(0);
  });

  it("detects local_modified when mtime increased beyond tolerance", async () => {
    const rec = makeSyncRecord({ key: "b.md", etag: "etag1", localMtime: 1_000 });
    // Mtime increased by 5 000 ms — well above the 1 000 ms tolerance
    const vault = mockVault([{ path: "b.md", mtime: 6_000, size: 512 }]);
    const s3 = mockS3([
      { vaultKey: "b.md", etag: "etag1", lastModified: new Date(500), size: 512 },
    ]);
    const db = mockDB([rec]);

    const { changes } = await computeChanges(vault, s3, db, DEFAULT_SETTINGS);
    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe("local_modified");
  });

  it("does NOT flag local_modified for sub-1s mtime jitter", async () => {
    const rec = makeSyncRecord({ key: "c.md", etag: "etag1", localMtime: 1_000 });
    // Only 500 ms apart — within the 1 000 ms jitter tolerance
    const vault = mockVault([{ path: "c.md", mtime: 1_500, size: 512 }]);
    const s3 = mockS3([
      { vaultKey: "c.md", etag: "etag1", lastModified: new Date(500), size: 512 },
    ]);
    const db = mockDB([rec]);

    const { changes } = await computeChanges(vault, s3, db, DEFAULT_SETTINGS);
    expect(changes).toHaveLength(0);
  });

  it("does NOT flag local_modified when content hash matches synced ETag (touch-no-change)", async () => {
    const content = new TextEncoder().encode("hello world").buffer;
    // Real MD5 of "hello world": 5eb63bbbe01eeed093cb22bb8f5acdc3
    const md5 = "5eb63bbbe01eeed093cb22bb8f5acdc3";
    const rec = makeSyncRecord({
      key: "touched.md",
      etag: md5,
      localMtime: 1_000,
      localSize: content.byteLength,
    });
    const vault = {
      getFiles: () => [{ path: "touched.md", stat: { mtime: 9_000, size: content.byteLength } }],
      adapter: { readBinary: async () => content },
    } as any;
    const s3 = mockS3([
      { vaultKey: "touched.md", etag: md5, lastModified: new Date(500), size: content.byteLength },
    ]);
    const db = mockDB([rec]);

    const { changes } = await computeChanges(vault, s3, db, DEFAULT_SETTINGS);
    expect(changes).toHaveLength(0);
  });

  it("detects remote_modified when ETag changed", async () => {
    const rec = makeSyncRecord({ key: "d.md", etag: "old_etag", localMtime: 1_000 });
    const vault = mockVault([{ path: "d.md", mtime: 1_000, size: 512 }]);
    const s3 = mockS3([
      { vaultKey: "d.md", etag: "new_etag", lastModified: new Date(2_000), size: 600 },
    ]);
    const db = mockDB([rec]);

    const { changes } = await computeChanges(vault, s3, db, DEFAULT_SETTINGS);
    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe("remote_modified");
    expect(changes[0].remoteEtag).toBe("new_etag");
  });

  it("detects conflict when both local mtime and remote ETag changed", async () => {
    const rec = makeSyncRecord({ key: "e.md", etag: "orig", localMtime: 1_000 });
    const vault = mockVault([{ path: "e.md", mtime: 9_000, size: 700 }]);
    const s3 = mockS3([
      { vaultKey: "e.md", etag: "changed", lastModified: new Date(8_000), size: 750 },
    ]);
    const db = mockDB([rec]);

    const { changes } = await computeChanges(vault, s3, db, DEFAULT_SETTINGS);
    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe("conflict");
    expect(changes[0].localMtime).toBe(9_000);
    expect(changes[0].remoteMtime).toEqual(new Date(8_000));
  });

  it("detects local_deleted: synced file missing locally, still on S3", async () => {
    const rec = makeSyncRecord({ key: "f.md" });
    const vault = mockVault([]); // file gone locally
    const s3 = mockS3([
      { vaultKey: "f.md", etag: "abc123", lastModified: new Date(1_000), size: 512 },
    ]);
    const db = mockDB([rec]);

    const { changes } = await computeChanges(vault, s3, db, DEFAULT_SETTINGS);
    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe("local_deleted");
  });

  it("detects remote_deleted: synced file missing on S3, still local", async () => {
    const rec = makeSyncRecord({ key: "g.md" });
    const vault = mockVault([{ path: "g.md", mtime: 1_000, size: 512 }]);
    const s3 = mockS3([]); // object gone from S3
    const db = mockDB([rec]);

    const { changes } = await computeChanges(vault, s3, db, DEFAULT_SETTINGS);
    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe("remote_deleted");
  });

  it("silently cleans up records when file is deleted from both sides", async () => {
    const rec = makeSyncRecord({ key: "h.md" });
    const vault = mockVault([]);
    const s3 = mockS3([]);
    const db = mockDB([rec]);

    const { changes } = await computeChanges(vault, s3, db, DEFAULT_SETTINGS);
    expect(changes).toHaveLength(0);
    expect(db._deleteMock).toHaveBeenCalledWith("h.md");
  });
});

describe("computeChanges — ignore patterns", () => {
  const settingsWithIgnore = {
    ...DEFAULT_SETTINGS,
    ignorePatterns: [".obsidian/workspace.json", "*.tmp", "Private/*"],
  };

  it("ignores files matching exact pattern", async () => {
    const vault = mockVault([{ path: ".obsidian/workspace.json", mtime: 1, size: 50 }]);
    const s3 = mockS3([]);
    const db = mockDB();

    const { changes } = await computeChanges(vault, s3, db, settingsWithIgnore);
    expect(changes).toHaveLength(0);
  });

  it("ignores files matching wildcard extension pattern", async () => {
    const vault = mockVault([{ path: "temp.tmp", mtime: 1, size: 10 }]);
    const s3 = mockS3([]);
    const db = mockDB();

    const { changes } = await computeChanges(vault, s3, db, settingsWithIgnore);
    expect(changes).toHaveLength(0);
  });

  it("ignores files matching directory glob", async () => {
    const vault = mockVault([{ path: "Private/secrets.md", mtime: 1, size: 100 }]);
    const s3 = mockS3([]);
    const db = mockDB();

    const { changes } = await computeChanges(vault, s3, db, settingsWithIgnore);
    expect(changes).toHaveLength(0);
  });

  it("does NOT ignore files that don't match any pattern", async () => {
    const vault = mockVault([{ path: "Notes/public.md", mtime: 1, size: 200 }]);
    const s3 = mockS3([]);
    const db = mockDB();

    const { changes } = await computeChanges(vault, s3, db, settingsWithIgnore);
    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe("local_new");
  });
});

describe("computeChanges — multiple files mixed", () => {
  it("handles multiple files with different change types simultaneously", async () => {
    const syncedEtag = "stable";
    const vault = mockVault([
      { path: "new-local.md", mtime: 1, size: 50 },       // local_new
      { path: "modified.md", mtime: 9_000, size: 200 },   // local_modified
      { path: "unchanged.md", mtime: 1_000, size: 300 },  // no change
    ]);
    const s3 = mockS3([
      { vaultKey: "new-remote.md", etag: "r1", lastModified: new Date(1), size: 60 }, // remote_new
      { vaultKey: "modified.md", etag: syncedEtag, lastModified: new Date(500), size: 200 },
      { vaultKey: "unchanged.md", etag: syncedEtag, lastModified: new Date(500), size: 300 },
    ]);
    const db = mockDB([
      makeSyncRecord({ key: "modified.md", etag: syncedEtag, localMtime: 1_000 }),
      makeSyncRecord({ key: "unchanged.md", etag: syncedEtag, localMtime: 1_000 }),
    ]);

    const { changes } = await computeChanges(vault, s3, db, DEFAULT_SETTINGS);

    const types = changes.map((c) => c.changeType).sort();
    expect(types).toEqual(["local_modified", "local_new", "remote_new"]);
  });
});

describe("computeChanges — totalLocal / totalRemote", () => {
  it("reports correct totals", async () => {
    const vault = mockVault([
      { path: "a.md", mtime: 1, size: 10 },
      { path: "b.md", mtime: 1, size: 10 },
    ]);
    const s3 = mockS3([
      { vaultKey: "x.md", etag: "e1", lastModified: new Date(1), size: 20 },
    ]);
    const db = mockDB();

    const { totalLocal, totalRemote } = await computeChanges(vault, s3, db, DEFAULT_SETTINGS);
    expect(totalLocal).toBe(2);
    expect(totalRemote).toBe(1);
  });
});

describe("groupChanges", () => {
  it("buckets changes into the correct groups", () => {
    const changes = [
      { key: "a.md", s3Key: "a.md", changeType: "local_new" as const },
      { key: "b.md", s3Key: "b.md", changeType: "local_modified" as const },
      { key: "c.md", s3Key: "c.md", changeType: "remote_new" as const },
      { key: "d.md", s3Key: "d.md", changeType: "conflict" as const },
      { key: "e.md", s3Key: "e.md", changeType: "local_deleted" as const },
      { key: "f.md", s3Key: "f.md", changeType: "remote_deleted" as const },
    ];
    const g = groupChanges(changes);
    expect(g.localNew).toHaveLength(1);
    expect(g.localModified).toHaveLength(1);
    expect(g.remoteNew).toHaveLength(1);
    expect(g.conflicts).toHaveLength(1);
    expect(g.localDeleted).toHaveLength(1);
    expect(g.remoteDeleted).toHaveLength(1);
    expect(g.remoteModified).toHaveLength(0);
  });
});

describe("hasChanges", () => {
  it("returns true when there are changes", () => {
    expect(hasChanges([{ key: "a.md", s3Key: "a.md", changeType: "local_new" }])).toBe(true);
  });

  it("returns false for empty array", () => {
    expect(hasChanges([])).toBe(false);
  });
});
