/**
 * Integration tests — real S3 API calls against LocalStack.
 *
 * Requires LocalStack running at LOCALSTACK_ENDPOINT (default http://localhost:4566).
 * Run locally:  docker compose up localstack -d && npm run test:integration
 * Run in CI:    docker compose up --build --abort-on-container-exit
 */

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeChanges } from "../../src/sync/differ";
import { LocalDB } from "../../src/sync/localdb";
import { S3ClientWrapper } from "../../src/s3/client";
import { executeSync } from "../../src/sync/engine";
import type { S3Config } from "../../src/types";
import { DEFAULT_SETTINGS } from "../../src/types";

// ─── Config ───────────────────────────────────────────────────────────────────

const ENDPOINT = process.env.LOCALSTACK_ENDPOINT ?? "http://localhost:4566";
const BUCKET   = `s3-git-sync-integration-${Date.now()}`;
const REGION   = "us-east-1";

const S3_CFG: S3Config = {
  authMethod:        "static",
  s3AccessKeyID:     "test",
  s3SecretAccessKey: "test",
  s3ProfileName:     "default",
  s3Endpoint:        ENDPOINT,
  s3Region:          REGION,
  s3BucketName:      BUCKET,
  s3Prefix:          "",
  forcePathStyle:    true,   // required for LocalStack
};

// Direct SDK client used only for test setup / teardown (create/delete bucket)
const rawClient = new S3Client({
  region:      REGION,
  endpoint:    ENDPOINT,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  forcePathStyle: true,
});

// ─── In-memory vault ──────────────────────────────────────────────────────────

class MemVault {
  private store = new Map<string, { bytes: Uint8Array; mtime: number }>();

  addFile(key: string, content: string | Uint8Array, mtime = Date.now()) {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.store.set(key, { bytes, mtime });
  }

  /** Update content with a mtime well in the future to exceed the 1 s tolerance */
  modifyFile(key: string, content: string | Uint8Array) {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.store.set(key, { bytes, mtime: Date.now() + 10_000 });
  }

  removeFile(key: string) { this.store.delete(key); }

  readText(key: string): string | undefined {
    const e = this.store.get(key);
    return e ? new TextDecoder().decode(e.bytes) : undefined;
  }

  has(key: string) { return this.store.has(key); }
  size() { return this.store.size; }

  // ── Obsidian Vault interface ────────────────────────────────────────────────

  getFiles() {
    return Array.from(this.store.entries()).map(([path, f]) => ({
      path,
      stat: { mtime: f.mtime, size: f.bytes.byteLength },
    }));
  }

  getAbstractFileByPath(path: string) {
    const f = this.store.get(path);
    if (!f) return null;
    return { path, stat: { mtime: f.mtime, size: f.bytes.byteLength } };
  }

  createFolder(_path: string) { /* folders are implicit */ }

  adapter = {
    readBinary: async (path: string): Promise<ArrayBuffer> => {
      const f = this.store.get(path);
      if (!f) throw new Error(`MemVault: file not found: ${path}`);
      const buf = f.bytes.buffer as ArrayBuffer;
      return buf.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength);
    },
    writeBinary: async (path: string, data: ArrayBuffer) => {
      this.store.set(path, { bytes: new Uint8Array(data), mtime: Date.now() });
    },
    exists: async (path: string) => this.store.has(path),
    trashSystem: async (path: string) => { this.store.delete(path); return true; },
    trashLocal:  async (path: string) => { this.store.delete(path); },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function emptyBucket() {
  const res = await rawClient.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  await Promise.all(
    (res.Contents ?? []).map((o) =>
      rawClient.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: o.Key! }))
    )
  );
}

function makeS3() { return new S3ClientWrapper(S3_CFG); }
function makeDB() { return new LocalDB("integration-test"); }

// ─── Suite setup ──────────────────────────────────────────────────────────────

beforeAll(async () => {
  try {
    await rawClient.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch (err: any) {
    // Ignore if the bucket somehow already exists
    if (err?.name !== "BucketAlreadyOwnedByYou") throw err;
  }
});

afterAll(async () => {
  await emptyBucket();
  await rawClient.send(new DeleteBucketCommand({ Bucket: BUCKET }));
});

// ─── Basic S3 client operations ───────────────────────────────────────────────

describe("S3ClientWrapper — basic operations", () => {
  const s3 = makeS3();

  it("testConnection succeeds against LocalStack", async () => {
    await expect(s3.testConnection()).resolves.toBeUndefined();
  });

  it("listObjects returns empty array for fresh bucket", async () => {
    await emptyBucket();
    const objects = await s3.listObjects();
    expect(objects).toHaveLength(0);
  });

  it("putObject uploads and returns an ETag", async () => {
    const data = new TextEncoder().encode("hello, LocalStack").buffer as ArrayBuffer;
    const etag = await s3.putObject("test/hello.md", data);
    expect(typeof etag).toBe("string");
    expect(etag.length).toBeGreaterThan(0);
  });

  it("listObjects finds the uploaded object", async () => {
    const objects = await s3.listObjects();
    expect(objects).toHaveLength(1);
    expect(objects[0].vaultKey).toBe("test/hello.md");
    expect(objects[0].size).toBe(17);
  });

  it("getObject downloads content matching what was uploaded", async () => {
    const buf = await s3.getObject("test/hello.md");
    const text = new TextDecoder().decode(buf);
    expect(text).toBe("hello, LocalStack");
  });

  it("deleteObject removes the object", async () => {
    await s3.deleteObject("test/hello.md");
    const objects = await s3.listObjects();
    expect(objects).toHaveLength(0);
  });

  it("putObject handles a file with nested path", async () => {
    const data = new TextEncoder().encode("nested content").buffer as ArrayBuffer;
    await s3.putObject("Notes/Projects/deep.md", data);
    const objects = await s3.listObjects();
    expect(objects.some((o) => o.vaultKey === "Notes/Projects/deep.md")).toBe(true);
    await s3.deleteObject("Notes/Projects/deep.md");
  });

  it("putObject with prefix maps vault keys correctly", async () => {
    const prefixedCfg: S3Config = { ...S3_CFG, s3Prefix: "my-vault/" };
    const s3p = new S3ClientWrapper(prefixedCfg);
    const data = new TextEncoder().encode("prefixed").buffer as ArrayBuffer;
    await s3p.putObject(s3p.vaultKeyToS3Key("note.md"), data);
    const objects = await s3p.listObjects();
    expect(objects).toHaveLength(1);
    expect(objects[0].vaultKey).toBe("note.md");
    expect(objects[0].s3Key).toBe("my-vault/note.md");
    await s3p.deleteObject("my-vault/note.md");
  });
});

// ─── Full sync cycle ──────────────────────────────────────────────────────────

describe("Full sync cycle — end-to-end scenarios", () => {
  // Each scenario creates its own fresh vault + DB but shares the bucket.
  // Empty it before every test so S3 state doesn't bleed between scenarios.
  beforeEach(async () => { await emptyBucket(); });
  afterAll(async  () => { await emptyBucket(); });

  it("Scenario 1 — fresh vault: all files are local_new and upload correctly", async () => {
    const s3    = makeS3();
    const db    = makeDB();
    const vault = new MemVault();

    vault.addFile("Notes/hello.md",       "# Hello\nWorld",        1_000_000);
    vault.addFile("Attachments/img.png",  new Uint8Array([1, 2, 3, 4]), 1_000_001);

    const { changes } = await computeChanges(vault as any, s3, db, DEFAULT_SETTINGS);
    expect(changes).toHaveLength(2);
    expect(changes.every((c) => c.changeType === "local_new")).toBe(true);

    const stats = await executeSync(changes, {}, vault as any, s3, db);
    expect(stats.uploaded).toBe(2);
    expect(stats.errors).toHaveLength(0);

    // Verify files are now on S3
    const objects = await s3.listObjects();
    expect(objects).toHaveLength(2);
    expect(objects.map((o) => o.vaultKey).sort()).toEqual(
      ["Attachments/img.png", "Notes/hello.md"]
    );

    // Verify sync records were written
    const records = await db.getAllSyncRecords();
    expect(records.size).toBe(2);
    expect(records.get("Notes/hello.md")?.etag).toBeTruthy();

    // Second computeChanges should show no changes (idempotent)
    const { changes: changes2 } = await computeChanges(vault as any, s3, db, DEFAULT_SETTINGS);
    expect(changes2).toHaveLength(0);
  });

  it("Scenario 2 — remote new file: appears in S3, gets downloaded to vault", async () => {
    const s3    = makeS3();
    const db    = makeDB();
    const vault = new MemVault();

    // Start with one known synced file
    vault.addFile("Notes/hello.md", "# Hello", 1_000_000);
    await executeSync(
      (await computeChanges(vault as any, s3, db, DEFAULT_SETTINGS)).changes,
      {}, vault as any, s3, db
    );

    // Inject a new file directly into S3 (simulates another device uploading)
    const remoteContent = "Remote note created elsewhere";
    await rawClient.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key:    "Remote/new.md",
      Body:   new TextEncoder().encode(remoteContent),
    }));

    const { changes } = await computeChanges(vault as any, s3, db, DEFAULT_SETTINGS);
    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe("remote_new");
    expect(changes[0].key).toBe("Remote/new.md");

    const stats = await executeSync(changes, {}, vault as any, s3, db);
    expect(stats.downloaded).toBe(1);
    expect(stats.errors).toHaveLength(0);

    // File should now be in vault
    expect(vault.has("Remote/new.md")).toBe(true);
    expect(vault.readText("Remote/new.md")).toBe(remoteContent);
  });

  it("Scenario 3 — local modified: changed file is uploaded with new content", async () => {
    const s3    = makeS3();
    const db    = makeDB();
    const vault = new MemVault();

    // Initial sync
    vault.addFile("Notes/draft.md", "v1 content", 1_000_000);
    await executeSync(
      (await computeChanges(vault as any, s3, db, DEFAULT_SETTINGS)).changes,
      {}, vault as any, s3, db
    );

    // Modify locally
    vault.modifyFile("Notes/draft.md", "v2 content — updated");

    const { changes } = await computeChanges(vault as any, s3, db, DEFAULT_SETTINGS);
    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe("local_modified");

    const stats = await executeSync(changes, {}, vault as any, s3, db);
    expect(stats.uploaded).toBe(1);

    // Verify S3 has the new content
    const downloaded = await s3.getObject("Notes/draft.md");
    expect(new TextDecoder().decode(downloaded)).toBe("v2 content — updated");
  });

  it("Scenario 4 — local deleted: file removed locally gets deleted from S3", async () => {
    const s3    = makeS3();
    const db    = makeDB();
    const vault = new MemVault();

    vault.addFile("Notes/to-delete.md", "delete me", 1_000_000);
    await executeSync(
      (await computeChanges(vault as any, s3, db, DEFAULT_SETTINGS)).changes,
      {}, vault as any, s3, db
    );

    // Delete locally
    vault.removeFile("Notes/to-delete.md");

    const { changes } = await computeChanges(vault as any, s3, db, DEFAULT_SETTINGS);
    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe("local_deleted");

    const stats = await executeSync(changes, {}, vault as any, s3, db);
    expect(stats.deletedFromS3).toBe(1);

    // Verify S3 no longer has the file
    const objects = await s3.listObjects();
    expect(objects.some((o) => o.vaultKey === "Notes/to-delete.md")).toBe(false);

    // Sync record should be cleaned up
    const records = await db.getAllSyncRecords();
    expect(records.has("Notes/to-delete.md")).toBe(false);
  });

  it("Scenario 5 — remote deleted: file removed from S3 gets deleted locally", async () => {
    const s3    = makeS3();
    const db    = makeDB();
    const vault = new MemVault();

    vault.addFile("Notes/remote-will-delete.md", "content", 1_000_000);
    await executeSync(
      (await computeChanges(vault as any, s3, db, DEFAULT_SETTINGS)).changes,
      {}, vault as any, s3, db
    );

    // Delete from S3 directly
    await rawClient.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: "Notes/remote-will-delete.md" }));

    const { changes } = await computeChanges(vault as any, s3, db, DEFAULT_SETTINGS);
    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe("remote_deleted");

    const stats = await executeSync(changes, {}, vault as any, s3, db);
    expect(stats.deletedFromLocal).toBe(1);
    expect(vault.has("Notes/remote-will-delete.md")).toBe(false);
  });

  it("Scenario 6 — conflict, local wins: local version is pushed to S3", async () => {
    const s3    = makeS3();
    const db    = makeDB();
    const vault = new MemVault();

    vault.addFile("Notes/conflict.md", "original", 1_000_000);
    await executeSync(
      (await computeChanges(vault as any, s3, db, DEFAULT_SETTINGS)).changes,
      {}, vault as any, s3, db
    );

    // Both sides change independently
    vault.modifyFile("Notes/conflict.md", "local edit");
    await rawClient.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key:    "Notes/conflict.md",
      Body:   new TextEncoder().encode("remote edit"),
    }));

    const { changes } = await computeChanges(vault as any, s3, db, DEFAULT_SETTINGS);
    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe("conflict");

    const resolutions = new Map([["Notes/conflict.md", "local" as const]]);
    const stats = await executeSync(
      changes, { conflictResolutions: resolutions }, vault as any, s3, db
    );
    expect(stats.conflicts).toBe(1);
    expect(stats.uploaded).toBe(1);

    // S3 should now have the local version
    const s3Content = new TextDecoder().decode(await s3.getObject("Notes/conflict.md"));
    expect(s3Content).toBe("local edit");
  });

  it("Scenario 7 — conflict, remote wins: backs up local file before overwriting", async () => {
    const s3    = makeS3();
    const db    = makeDB();
    const vault = new MemVault();

    vault.addFile("Notes/conflict2.md", "original", 1_000_000);
    await executeSync(
      (await computeChanges(vault as any, s3, db, DEFAULT_SETTINGS)).changes,
      {}, vault as any, s3, db
    );

    // Both sides change
    vault.modifyFile("Notes/conflict2.md", "local version");
    await rawClient.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key:    "Notes/conflict2.md",
      Body:   new TextEncoder().encode("remote version"),
    }));

    const { changes } = await computeChanges(vault as any, s3, db, DEFAULT_SETTINGS);
    const resolutions = new Map([["Notes/conflict2.md", "remote" as const]]);
    await executeSync(changes, { conflictResolutions: resolutions }, vault as any, s3, db);

    // Vault should now contain the remote version
    expect(vault.readText("Notes/conflict2.md")).toBe("remote version");

    // A backup of the local version should exist under conflict/
    const backupKeys = Array.from(vault["store"].keys()).filter((k) =>
      k.startsWith("conflict/Notes/conflict2") && k.includes(".conflict-")
    );
    expect(backupKeys).toHaveLength(1);
    expect(vault.readText(backupKeys[0])).toBe("local version");
  });

  it("Scenario 8 — ignore patterns: ignored files are never synced", async () => {
    const s3       = makeS3();
    const db       = makeDB();
    const vault    = new MemVault();
    const settings = {
      ...DEFAULT_SETTINGS,
      ignorePatterns: [".obsidian/workspace.json", "tmp/*"],
    };

    vault.addFile("Notes/keep.md",                "keep this",  1_000_000);
    vault.addFile(".obsidian/workspace.json",      "{}",         1_000_001);
    vault.addFile("tmp/scratch.md",               "scratch",    1_000_002);

    const { changes } = await computeChanges(vault as any, s3, db, settings);
    expect(changes).toHaveLength(1);
    expect(changes[0].key).toBe("Notes/keep.md");
  });

  it("Scenario 9 — prefix isolation: two vaults share one bucket without collision", async () => {
    const cfgA: S3Config = { ...S3_CFG, s3Prefix: "vault-a/" };
    const cfgB: S3Config = { ...S3_CFG, s3Prefix: "vault-b/" };
    const s3A = new S3ClientWrapper(cfgA);
    const s3B = new S3ClientWrapper(cfgB);
    const dbA = makeDB();
    const dbB = makeDB();

    const vaultA = new MemVault();
    const vaultB = new MemVault();
    vaultA.addFile("shared-name.md", "content from A", 1_000_000);
    vaultB.addFile("shared-name.md", "content from B", 1_000_000);

    await executeSync(
      (await computeChanges(vaultA as any, s3A, dbA, DEFAULT_SETTINGS)).changes,
      {}, vaultA as any, s3A, dbA
    );
    await executeSync(
      (await computeChanges(vaultB as any, s3B, dbB, DEFAULT_SETTINGS)).changes,
      {}, vaultB as any, s3B, dbB
    );

    // Each wrapper only sees its own prefix
    expect((await s3A.listObjects()).every((o) => o.s3Key.startsWith("vault-a/"))).toBe(true);
    expect((await s3B.listObjects()).every((o) => o.s3Key.startsWith("vault-b/"))).toBe(true);

    // Each sees exactly one file
    expect(await s3A.listObjects()).toHaveLength(1);
    expect(await s3B.listObjects()).toHaveLength(1);

    // Neither interferes with the other
    const { changes: changesA } = await computeChanges(vaultA as any, s3A, dbA, DEFAULT_SETTINGS);
    expect(changesA).toHaveLength(0);

    // Clean up prefixed objects
    await s3A.deleteObject("vault-a/shared-name.md");
    await s3B.deleteObject("vault-b/shared-name.md");
  });
});
