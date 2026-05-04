import { describe, it, expect, vi } from "vitest";
import { backupFilename, downloadAll, buildZip, totalBytes } from "../src/sync/backup";
import type { RemoteObject } from "../src/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeObject(vaultKey: string, size = 100): RemoteObject {
  return {
    vaultKey,
    s3Key: `prefix/${vaultKey}`,
    etag: "abc",
    lastModified: new Date(),
    size,
  };
}

function makeS3(responses: Map<string, ArrayBuffer>) {
  return {
    getObject: vi.fn(async (s3Key: string) => {
      const data = responses.get(s3Key);
      if (!data) throw new Error(`No mock for ${s3Key}`);
      return data;
    }),
  };
}

// ─── backupFilename ───────────────────────────────────────────────────────────

describe("backupFilename", () => {
  it("includes the date in YYYY-MM-DD format", () => {
    const name = backupFilename("my-vault", new Date("2026-04-30T12:00:00Z"));
    expect(name).toBe("s3-backup-my-vault-2026-04-30.zip");
  });

  it("sanitises spaces to hyphens", () => {
    const name = backupFilename("My Vault", new Date("2026-04-30T00:00:00Z"));
    expect(name).toMatch(/^s3-backup-my-vault-/);
  });

  it("sanitises special characters", () => {
    const name = backupFilename("vault/2026 (main)", new Date("2026-01-01T00:00:00Z"));
    expect(name).not.toMatch(/[/ ()]/);
    expect(name).toMatch(/\.zip$/);
  });

  it("collapses consecutive hyphens produced by sanitisation", () => {
    const name = backupFilename("a  b", new Date("2026-01-01T00:00:00Z"));
    expect(name).not.toContain("--");
  });

  it("lowercases the vault name", () => {
    const name = backupFilename("MyVault", new Date("2026-01-01T00:00:00Z"));
    expect(name).toMatch(/^s3-backup-myvault-/);
  });

  it("always ends with .zip", () => {
    expect(backupFilename("vault", new Date())).toMatch(/\.zip$/);
  });
});

// ─── downloadAll ─────────────────────────────────────────────────────────────

describe("downloadAll", () => {
  it("downloads every object and returns their bytes", async () => {
    const objects = [makeObject("a.md"), makeObject("b.md")];
    const s3 = makeS3(new Map([
      ["prefix/a.md", new TextEncoder().encode("hello").buffer as ArrayBuffer],
      ["prefix/b.md", new TextEncoder().encode("world").buffer as ArrayBuffer],
    ]));
    const { files, errors } = await downloadAll(objects, s3 as never, () => {}, new AbortController().signal);
    expect(files.size).toBe(2);
    expect(errors).toHaveLength(0);
    expect(new TextDecoder().decode(files.get("a.md")!)).toBe("hello");
    expect(new TextDecoder().decode(files.get("b.md")!)).toBe("world");
  });

  it("uses the vaultKey (not s3Key) as the map key", async () => {
    const objects = [makeObject("notes/hello.md")];
    const s3 = makeS3(new Map([
      ["prefix/notes/hello.md", new TextEncoder().encode("hi").buffer as ArrayBuffer],
    ]));
    const { files } = await downloadAll(objects, s3 as never, () => {}, new AbortController().signal);
    expect(files.has("notes/hello.md")).toBe(true);
    expect(files.has("prefix/notes/hello.md")).toBe(false);
  });

  it("fires the progress callback for every file", async () => {
    const objects = [makeObject("a.md"), makeObject("b.md"), makeObject("c.md")];
    const s3 = makeS3(new Map([
      ["prefix/a.md", new ArrayBuffer(1)],
      ["prefix/b.md", new ArrayBuffer(1)],
      ["prefix/c.md", new ArrayBuffer(1)],
    ]));
    const progress: number[] = [];
    await downloadAll(objects, s3 as never, ({ done }) => progress.push(done), new AbortController().signal);
    expect(progress).toEqual([1, 2, 3]);
  });

  it("reports the correct total in every progress callback", async () => {
    const objects = [makeObject("a.md"), makeObject("b.md")];
    const s3 = makeS3(new Map([
      ["prefix/a.md", new ArrayBuffer(1)],
      ["prefix/b.md", new ArrayBuffer(1)],
    ]));
    const totals: number[] = [];
    await downloadAll(objects, s3 as never, ({ total }) => totals.push(total), new AbortController().signal);
    expect(totals).toEqual([2, 2]);
  });

  it("collects per-file errors and continues downloading remaining files", async () => {
    const objects = [makeObject("ok.md"), makeObject("bad.md"), makeObject("also-ok.md")];
    const s3 = {
      getObject: vi.fn(async (s3Key: string) => {
        if (s3Key.includes("bad")) throw new Error("S3 read failed");
        return new TextEncoder().encode("data").buffer as ArrayBuffer;
      }),
    };
    const { files, errors } = await downloadAll(objects, s3 as never, () => {}, new AbortController().signal);
    expect(files.size).toBe(2);          // ok.md + also-ok.md
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bad.md");
    expect(errors[0]).toContain("S3 read failed");
  });

  it("stops downloading when the abort signal fires", async () => {
    const controller = new AbortController();
    const objects = Array.from({ length: 10 }, (_, i) => makeObject(`file${i}.md`));
    let callCount = 0;
    const s3 = {
      getObject: vi.fn(async () => {
        callCount++;
        // Abort after the first download
        if (callCount === 1) controller.abort();
        return new ArrayBuffer(1);
      }),
    };
    const { files } = await downloadAll(objects, s3 as never, () => {}, controller.signal);
    // Only files processed before abort completes should be present
    expect(files.size).toBeLessThan(10);
  });

  it("returns empty result for empty object list", async () => {
    const s3 = { getObject: vi.fn() };
    const { files, errors } = await downloadAll([], s3 as never, () => {}, new AbortController().signal);
    expect(files.size).toBe(0);
    expect(errors).toHaveLength(0);
    expect(s3.getObject).not.toHaveBeenCalled();
  });
});

// ─── totalBytes ───────────────────────────────────────────────────────────────

describe("totalBytes", () => {
  it("sums the byte lengths of all files", () => {
    const files = new Map([
      ["a.md", new Uint8Array(100)],
      ["b.md", new Uint8Array(200)],
      ["c.md", new Uint8Array(50)],
    ]);
    expect(totalBytes(files)).toBe(350);
  });

  it("returns 0 for an empty map", () => {
    expect(totalBytes(new Map())).toBe(0);
  });
});

// ─── buildZip ─────────────────────────────────────────────────────────────────

describe("buildZip", () => {
  it("produces a non-empty Uint8Array", async () => {
    const files = new Map([["hello.md", new Uint8Array(new TextEncoder().encode("hello world"))]]);
    const result = await buildZip(files);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.byteLength).toBeGreaterThan(0);
  });

  it("ZIP magic bytes are present (PK header)", async () => {
    const files = new Map([["file.txt", new Uint8Array([72, 101, 108, 108, 111])]]);
    const result = await buildZip(files);
    // ZIP files start with PK (0x50 0x4B)
    expect(result[0]).toBe(0x50);
    expect(result[1]).toBe(0x4b);
  });

  it("produces a larger archive when given multiple files", async () => {
    const one = new Map([["a.txt", new Uint8Array([1])]]);
    const two = new Map([["a.txt", new Uint8Array([1])], ["b.txt", new Uint8Array([2])]]);
    const sizeOne = (await buildZip(one)).byteLength;
    const sizeTwo = (await buildZip(two)).byteLength;
    expect(sizeTwo).toBeGreaterThan(sizeOne);
  });

  it("handles an empty file map", async () => {
    const result = await buildZip(new Map());
    expect(result).toBeInstanceOf(Uint8Array);
  });
});
