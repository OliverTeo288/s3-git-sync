import { describe, it, expect } from "vitest";
import { dryRunStats } from "../src/syncEngine";
import type { FileChange } from "../src/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeChange(changeType: FileChange["changeType"], key = "test.md"): FileChange {
  return { key, s3Key: key, changeType };
}

// ─── dryRunStats ─────────────────────────────────────────────────────────────

describe("dryRunStats", () => {
  it("counts local_new and local_modified as uploads", () => {
    const changes = [makeChange("local_new"), makeChange("local_modified")];
    const stats = dryRunStats(changes, {});
    expect(stats.uploaded).toBe(2);
    expect(stats.downloaded).toBe(0);
    expect(stats.deletedFromS3).toBe(0);
    expect(stats.deletedFromLocal).toBe(0);
    expect(stats.conflicts).toBe(0);
  });

  it("counts remote_new and remote_modified as downloads", () => {
    const changes = [makeChange("remote_new"), makeChange("remote_modified")];
    const stats = dryRunStats(changes, {});
    expect(stats.downloaded).toBe(2);
    expect(stats.uploaded).toBe(0);
  });

  it("counts local_deleted as deletedFromS3", () => {
    const changes = [makeChange("local_deleted")];
    const stats = dryRunStats(changes, {});
    expect(stats.deletedFromS3).toBe(1);
    expect(stats.deletedFromLocal).toBe(0);
  });

  it("counts remote_deleted as deletedFromLocal", () => {
    const changes = [makeChange("remote_deleted")];
    const stats = dryRunStats(changes, {});
    expect(stats.deletedFromLocal).toBe(1);
    expect(stats.deletedFromS3).toBe(0);
  });

  it("counts conflicts separately", () => {
    const changes = [makeChange("conflict")];
    const stats = dryRunStats(changes, {});
    expect(stats.conflicts).toBe(1);
    expect(stats.uploaded).toBe(0);
    expect(stats.downloaded).toBe(0);
  });

  it("handles mixed change types correctly", () => {
    const changes = [
      makeChange("local_new", "a.md"),
      makeChange("local_modified", "b.md"),
      makeChange("remote_new", "c.md"),
      makeChange("local_deleted", "d.md"),
      makeChange("remote_deleted", "e.md"),
      makeChange("conflict", "f.md"),
    ];
    const stats = dryRunStats(changes, {});
    expect(stats.uploaded).toBe(2);
    expect(stats.downloaded).toBe(1);
    expect(stats.deletedFromS3).toBe(1);
    expect(stats.deletedFromLocal).toBe(1);
    expect(stats.conflicts).toBe(1);
    expect(stats.errors).toHaveLength(0);
  });

  it("returns zero stats for empty change list", () => {
    const stats = dryRunStats([], {});
    expect(stats.uploaded).toBe(0);
    expect(stats.downloaded).toBe(0);
    expect(stats.deletedFromS3).toBe(0);
    expect(stats.deletedFromLocal).toBe(0);
    expect(stats.conflicts).toBe(0);
  });

  it("skips files not in the selectedKeys set", () => {
    const changes = [
      makeChange("local_new", "included.md"),
      makeChange("local_new", "excluded.md"),
    ];
    const stats = dryRunStats(changes, { selectedKeys: new Set(["included.md"]) });
    expect(stats.uploaded).toBe(1);
  });

  it("includes all files when selectedKeys is undefined", () => {
    const changes = [
      makeChange("local_new", "a.md"),
      makeChange("local_new", "b.md"),
    ];
    const stats = dryRunStats(changes, {});
    expect(stats.uploaded).toBe(2);
  });

  it("returns empty selectedKeys set as zero stats", () => {
    const changes = [makeChange("local_new"), makeChange("remote_modified")];
    const stats = dryRunStats(changes, { selectedKeys: new Set() });
    expect(stats.uploaded).toBe(0);
    expect(stats.downloaded).toBe(0);
  });
});

// ─── validateAccessKeyId ──────────────────────────────────────────────────────

describe("validateAccessKeyId (from s3client)", () => {
  // Dynamic import to avoid bundling the full AWS SDK
  it("accepts valid AKIA key", async () => {
    const { validateAccessKeyId } = await import("../src/s3client");
    expect(validateAccessKeyId("AKIAIOSFODNN7EXAMPLE")).toBeNull();
  });

  it("accepts valid ASIA (session) key", async () => {
    const { validateAccessKeyId } = await import("../src/s3client");
    expect(validateAccessKeyId("ASIAIOSFODNN7EXAMPLE")).toBeNull();
  });

  it("rejects empty string", async () => {
    const { validateAccessKeyId } = await import("../src/s3client");
    expect(validateAccessKeyId("")).not.toBeNull();
  });

  it("rejects key that is too short", async () => {
    const { validateAccessKeyId } = await import("../src/s3client");
    expect(validateAccessKeyId("AKIA123")).not.toBeNull();
  });

  it("rejects key with lowercase letters", async () => {
    const { validateAccessKeyId } = await import("../src/s3client");
    expect(validateAccessKeyId("akiaiosfodnn7example")).not.toBeNull();
  });

  it("rejects key that doesn't start with AKIA/ASIA/AROA/AIDA", async () => {
    const { validateAccessKeyId } = await import("../src/s3client");
    expect(validateAccessKeyId("XXXX0000000000000000")).not.toBeNull();
  });
});

// ─── S3ClientWrapper helpers ──────────────────────────────────────────────────

describe("S3ClientWrapper — prefix handling", () => {
  it("normalises prefix to always end with /", async () => {
    const { S3ClientWrapper } = await import("../src/s3client");
    const cfg = {
      authMethod: "static" as const,
      s3AccessKeyID: "AKIAIOSFODNN7EXAMPLE",
      s3SecretAccessKey: "secret",
      s3ProfileName: "default",
      s3Endpoint: "",
      s3Region: "us-east-1",
      s3BucketName: "test-bucket",
      s3Prefix: "my-vault",   // no trailing slash
      forcePathStyle: false,
    };
    const client = new S3ClientWrapper(cfg);
    expect(client.prefix).toBe("my-vault/");
  });

  it("returns empty prefix when s3Prefix is blank", async () => {
    const { S3ClientWrapper } = await import("../src/s3client");
    const cfg = {
      authMethod: "static" as const,
      s3AccessKeyID: "AKIAIOSFODNN7EXAMPLE",
      s3SecretAccessKey: "secret",
      s3ProfileName: "default",
      s3Endpoint: "",
      s3Region: "us-east-1",
      s3BucketName: "test-bucket",
      s3Prefix: "",
      forcePathStyle: false,
    };
    const client = new S3ClientWrapper(cfg);
    expect(client.prefix).toBe("");
  });

  it("converts vault keys to S3 keys using the prefix", async () => {
    const { S3ClientWrapper } = await import("../src/s3client");
    const cfg = {
      authMethod: "static" as const,
      s3AccessKeyID: "AKIAIOSFODNN7EXAMPLE",
      s3SecretAccessKey: "secret",
      s3ProfileName: "default",
      s3Endpoint: "",
      s3Region: "us-east-1",
      s3BucketName: "test-bucket",
      s3Prefix: "vault/",
      forcePathStyle: false,
    };
    const client = new S3ClientWrapper(cfg);
    expect(client.vaultKeyToS3Key("Notes/hello.md")).toBe("vault/Notes/hello.md");
  });

  it("strips the prefix when converting S3 keys back to vault keys", async () => {
    const { S3ClientWrapper } = await import("../src/s3client");
    const cfg = {
      authMethod: "static" as const,
      s3AccessKeyID: "AKIAIOSFODNN7EXAMPLE",
      s3SecretAccessKey: "secret",
      s3ProfileName: "default",
      s3Endpoint: "",
      s3Region: "us-east-1",
      s3BucketName: "test-bucket",
      s3Prefix: "vault/",
      forcePathStyle: false,
    };
    const client = new S3ClientWrapper(cfg);
    expect(client.s3KeyToVaultKey("vault/Notes/hello.md")).toBe("Notes/hello.md");
  });
});
