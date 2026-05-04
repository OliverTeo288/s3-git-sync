import { describe, it, expect } from "vitest";
import { assertSafeProfileName, assertSafeVaultKey } from "../src/utils";

describe("assertSafeVaultKey", () => {
  it("accepts ordinary vault paths", () => {
    expect(() => assertSafeVaultKey("Notes/file.md")).not.toThrow();
    expect(() => assertSafeVaultKey("a/b/c/d.txt")).not.toThrow();
    expect(() => assertSafeVaultKey("file with spaces.md")).not.toThrow();
    expect(() => assertSafeVaultKey("привет.md")).not.toThrow();
  });

  it("rejects empty keys", () => {
    expect(() => assertSafeVaultKey("")).toThrow(/Empty/);
  });

  it("rejects parent-directory traversal", () => {
    expect(() => assertSafeVaultKey("../etc/passwd")).toThrow(/parent/);
    expect(() => assertSafeVaultKey("a/../../b")).toThrow(/parent/);
    expect(() => assertSafeVaultKey("a/..")).toThrow(/parent/);
  });

  it("rejects absolute paths", () => {
    expect(() => assertSafeVaultKey("/etc/passwd")).toThrow(/absolute/);
  });

  it("rejects Windows drive paths and backslashes", () => {
    expect(() => assertSafeVaultKey("C:/Windows/x")).toThrow(/Windows/);
    expect(() => assertSafeVaultKey("a\\b")).toThrow(/backslash/);
  });

  it("rejects NUL bytes", () => {
    expect(() => assertSafeVaultKey("file\0.md")).toThrow(/NUL/);
  });

  it("does not reject filenames containing dots", () => {
    expect(() => assertSafeVaultKey(".hidden")).not.toThrow();
    expect(() => assertSafeVaultKey("file..backup.md")).not.toThrow();
    expect(() => assertSafeVaultKey("a/.dotfile")).not.toThrow();
  });
});

describe("assertSafeProfileName", () => {
  it("accepts standard AWS profile names", () => {
    expect(() => assertSafeProfileName("default")).not.toThrow();
    expect(() => assertSafeProfileName("my-work")).not.toThrow();
    expect(() => assertSafeProfileName("dev_2")).not.toThrow();
    expect(() => assertSafeProfileName("foo.bar")).not.toThrow();
  });

  it("rejects shell metacharacters", () => {
    expect(() => assertSafeProfileName("default; rm -rf /")).toThrow();
    expect(() => assertSafeProfileName("a&b")).toThrow();
    expect(() => assertSafeProfileName("a|b")).toThrow();
    expect(() => assertSafeProfileName("$(whoami)")).toThrow();
    expect(() => assertSafeProfileName("`id`")).toThrow();
    expect(() => assertSafeProfileName("a b")).toThrow();
  });

  it("rejects empty input", () => {
    expect(() => assertSafeProfileName("")).toThrow();
  });
});
