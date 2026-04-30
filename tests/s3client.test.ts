import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { errorCode, parseAWSConfigForSSO, EC } from "../src/s3client";

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
