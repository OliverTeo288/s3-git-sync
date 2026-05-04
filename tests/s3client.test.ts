import { describe, it, expect, afterEach, vi } from "vitest";
import { errorCode, EC } from "../src/s3/errors";
import { parseAWSConfigForSSO } from "../src/s3/client";

// ─── errorCode ────────────────────────────────────────────────────────────────

describe("errorCode", () => {
  it("returns NOT_FOUND for NoSuchBucket", () => {
    expect(errorCode({ name: "NoSuchBucket" })).toBe(EC.NOT_FOUND);
  });

  it("returns ACCESS_DENIED for AccessDenied name", () => {
    expect(errorCode({ name: "AccessDenied" })).toBe(EC.ACCESS_DENIED);
  });

  it("returns ACCESS_DENIED for Forbidden name", () => {
    expect(errorCode({ name: "Forbidden" })).toBe(EC.ACCESS_DENIED);
  });

  it("returns ACCESS_DENIED when message contains 'access denied'", () => {
    expect(errorCode({ name: "Error", message: "Access denied to resource" })).toBe(EC.ACCESS_DENIED);
  });

  it("returns AUTH for InvalidClientTokenId", () => {
    expect(errorCode({ name: "InvalidClientTokenId" })).toBe(EC.AUTH);
  });

  it("returns AUTH for AuthFailure", () => {
    expect(errorCode({ name: "AuthFailure" })).toBe(EC.AUTH);
  });

  it("returns AUTH when message contains 'invalid access key'", () => {
    expect(errorCode({ name: "Error", message: "Invalid access key provided" })).toBe(EC.AUTH);
  });

  it("returns NETWORK for TimeoutError", () => {
    expect(errorCode({ name: "TimeoutError" })).toBe(EC.NETWORK);
  });

  it("returns NETWORK when message contains 'failed to fetch'", () => {
    expect(errorCode({ name: "Error", message: "Failed to fetch" })).toBe(EC.NETWORK);
  });

  it("returns NETWORK when message contains 'timed out'", () => {
    expect(errorCode({ name: "Error", message: "Request timed out" })).toBe(EC.NETWORK);
  });

  it("returns UNKNOWN for unrecognised errors", () => {
    expect(errorCode({ name: "SomeRandomError", message: "something went wrong" })).toBe(EC.UNKNOWN);
  });

  it("returns UNKNOWN for null/undefined", () => {
    expect(errorCode(null)).toBe(EC.UNKNOWN);
    expect(errorCode(undefined)).toBe(EC.UNKNOWN);
  });
});

// ─── parseAWSConfigForSSO ─────────────────────────────────────────────────────
// Injects a fake `require` on globalThis so nodeRequire() works without Electron.

describe("parseAWSConfigForSSO", () => {
  let mockFs: { existsSync: ReturnType<typeof vi.fn>; readFileSync: ReturnType<typeof vi.fn> };

  function setupRequire(configContent: string | null) {
    mockFs = {
      existsSync: vi.fn().mockReturnValue(configContent !== null),
      readFileSync: vi.fn().mockReturnValue(configContent ?? ""),
    };
    (globalThis as Record<string, unknown>)["require"] = (id: string) => {
      if (id === "fs") return mockFs;
      if (id === "os") return { homedir: () => "/home/user" };
      if (id === "path") return { join: (...parts: string[]) => parts.join("/") };
      throw new Error(`Unexpected require("${id}")`);
    };
  }

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)["require"];
  });

  it("returns null when ~/.aws/config does not exist", () => {
    setupRequire(null);
    expect(parseAWSConfigForSSO("default")).toBeNull();
  });

  it("returns sso_start_url from a legacy [default] profile", () => {
    setupRequire(`
[default]
sso_start_url = https://my-sso.awsapps.com/start
sso_region = ap-southeast-1
    `);
    expect(parseAWSConfigForSSO("default")).toBe("https://my-sso.awsapps.com/start");
  });

  it("returns sso_start_url from a named profile", () => {
    setupRequire(`
[profile my-work]
sso_start_url = https://work.awsapps.com/start
sso_region = us-east-1
    `);
    expect(parseAWSConfigForSSO("my-work")).toBe("https://work.awsapps.com/start");
  });

  it("returns sso_start_url from a modern sso-session block", () => {
    setupRequire(`
[profile dev]
sso_session = my-sso
sso_account_id = 123456789012
sso_role_name = DevRole

[sso-session my-sso]
sso_start_url = https://modern-sso.awsapps.com/start
sso_region = eu-west-1
    `);
    expect(parseAWSConfigForSSO("dev")).toBe("https://modern-sso.awsapps.com/start");
  });

  it("returns null when the requested profile is not in the config", () => {
    setupRequire(`
[profile other-profile]
sso_start_url = https://other.awsapps.com/start
    `);
    expect(parseAWSConfigForSSO("missing-profile")).toBeNull();
  });

  it("returns null when profile has no sso_start_url or sso_session", () => {
    setupRequire(`
[profile no-sso]
region = ap-southeast-1
output = json
    `);
    expect(parseAWSConfigForSSO("no-sso")).toBeNull();
  });

  it("returns null when require throws (non-Electron environment)", () => {
    (globalThis as Record<string, unknown>)["require"] = () => {
      throw new Error("require not available");
    };
    expect(parseAWSConfigForSSO("default")).toBeNull();
  });
});

// ─── S3ClientWrapper — version API ───────────────────────────────────────────

const makeCfg = () => ({
  authMethod: "static" as const,
  s3AccessKeyID: "AKIAIOSFODNN7EXAMPLE",
  s3SecretAccessKey: "secret",
  s3ProfileName: "default",
  s3Endpoint: "",
  s3Region: "us-east-1",
  s3BucketName: "test-bucket",
  s3Prefix: "",
  forcePathStyle: false,
});

// Helper to spy on the private S3Client inside S3ClientWrapper
function mockSend(client: unknown) {
  return vi.spyOn(
    (client as Record<string, Record<string, unknown>>)["_client"],
    "send"
  );
}

describe("S3ClientWrapper — listObjectVersions", () => {
  it("returns versions sorted newest first", async () => {
    const { S3ClientWrapper } = await import("../src/s3/client");
    const client = new S3ClientWrapper(makeCfg());
    mockSend(client).mockResolvedValueOnce({
      Versions: [
        { Key: "file.md", VersionId: "v1", LastModified: new Date("2024-01-01"), Size: 100, ETag: '"aaa"', IsLatest: false },
        { Key: "file.md", VersionId: "v2", LastModified: new Date("2024-02-01"), Size: 200, ETag: '"bbb"', IsLatest: true },
      ],
    });
    const versions = await client.listObjectVersions("file.md");
    expect(versions).toHaveLength(2);
    expect(versions[0].versionId).toBe("v2"); // newest first
    expect(versions[1].versionId).toBe("v1");
  });

  it("excludes entries whose Key does not exactly match (guards against prefix false-matches)", async () => {
    const { S3ClientWrapper } = await import("../src/s3/client");
    const client = new S3ClientWrapper(makeCfg());
    mockSend(client).mockResolvedValueOnce({
      Versions: [
        { Key: "notes/file.md",     VersionId: "v1", LastModified: new Date(), Size: 100, ETag: '"aaa"', IsLatest: true },
        { Key: "notes/file.md.bak", VersionId: "v2", LastModified: new Date(), Size: 100, ETag: '"bbb"', IsLatest: true },
      ],
    });
    const versions = await client.listObjectVersions("notes/file.md");
    expect(versions).toHaveLength(1);
    expect(versions[0].versionId).toBe("v1");
  });

  it("strips surrounding quotes from ETags", async () => {
    const { S3ClientWrapper } = await import("../src/s3/client");
    const client = new S3ClientWrapper(makeCfg());
    mockSend(client).mockResolvedValueOnce({
      Versions: [
        { Key: "file.md", VersionId: "v1", LastModified: new Date(), Size: 100, ETag: '"abc123"', IsLatest: true },
      ],
    });
    const [v] = await client.listObjectVersions("file.md");
    expect(v.etag).toBe("abc123");
  });

  it("returns empty array when Versions is undefined (versioning disabled on bucket)", async () => {
    const { S3ClientWrapper } = await import("../src/s3/client");
    const client = new S3ClientWrapper(makeCfg());
    mockSend(client).mockResolvedValueOnce({ Versions: undefined });
    expect(await client.listObjectVersions("file.md")).toHaveLength(0);
  });

  it("correctly maps isLatest flag for each version", async () => {
    const { S3ClientWrapper } = await import("../src/s3/client");
    const client = new S3ClientWrapper(makeCfg());
    mockSend(client).mockResolvedValueOnce({
      Versions: [
        { Key: "file.md", VersionId: "cur", LastModified: new Date("2024-02-01"), Size: 100, ETag: '"a"', IsLatest: true  },
        { Key: "file.md", VersionId: "old", LastModified: new Date("2024-01-01"), Size:  80, ETag: '"b"', IsLatest: false },
      ],
    });
    const versions = await client.listObjectVersions("file.md");
    expect(versions[0].isLatest).toBe(true);
    expect(versions[1].isLatest).toBe(false);
  });

  it("passes the correct s3Key as Prefix in the ListObjectVersions command", async () => {
    const { S3ClientWrapper } = await import("../src/s3/client");
    const client = new S3ClientWrapper(makeCfg());
    const spy = mockSend(client).mockResolvedValueOnce({ Versions: [] });
    await client.listObjectVersions("vault/notes/file.md");
    const cmd = (spy.mock.calls[0] as [{ input: Record<string, unknown> }])[0];
    expect(cmd.input["Prefix"]).toBe("vault/notes/file.md");
  });
});

describe("S3ClientWrapper — getObjectVersion", () => {
  it("returns the versioned object body as an ArrayBuffer", async () => {
    const { S3ClientWrapper } = await import("../src/s3/client");
    const client = new S3ClientWrapper(makeCfg());
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    mockSend(client).mockResolvedValueOnce({ Body: new Blob([bytes]) });
    const data = await client.getObjectVersion("notes/file.md", "abc-version-id");
    expect(new Uint8Array(data)).toEqual(bytes);
  });

  it("passes the VersionId through to the GetObject command", async () => {
    const { S3ClientWrapper } = await import("../src/s3/client");
    const client = new S3ClientWrapper(makeCfg());
    const spy = mockSend(client).mockResolvedValueOnce({ Body: new Blob([new Uint8Array([0])]) });
    await client.getObjectVersion("file.md", "my-version-id");
    const cmd = (spy.mock.calls[0] as [{ input: Record<string, unknown> }])[0];
    expect(cmd.input["VersionId"]).toBe("my-version-id");
  });

  it("passes the correct Key to the GetObject command", async () => {
    const { S3ClientWrapper } = await import("../src/s3/client");
    const client = new S3ClientWrapper(makeCfg());
    const spy = mockSend(client).mockResolvedValueOnce({ Body: new Blob([new Uint8Array([0])]) });
    await client.getObjectVersion("notes/deep/file.md", "vid");
    const cmd = (spy.mock.calls[0] as [{ input: Record<string, unknown> }])[0];
    expect(cmd.input["Key"]).toBe("notes/deep/file.md");
  });
});
