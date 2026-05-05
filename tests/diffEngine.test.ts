import { describe, it, expect } from "vitest";
import { computeDiff, mergeWithConflictMarkers, isTextFile } from "../src/sync/diffEngine";

// ─── isTextFile ───────────────────────────────────────────────────────────────

describe("isTextFile", () => {
  it("recognises markdown, json, ts", () => {
    expect(isTextFile("notes/foo.md")).toBe(true);
    expect(isTextFile("config.json")).toBe(true);
    expect(isTextFile("src/app.ts")).toBe(true);
  });

  it("rejects binary extensions", () => {
    expect(isTextFile("image.png")).toBe(false);
    expect(isTextFile("archive.zip")).toBe(false);
    expect(isTextFile("font.woff2")).toBe(false);
  });

  it("returns false for files with no extension", () => {
    expect(isTextFile("Makefile")).toBe(false);
  });
});

// ─── computeDiff ──────────────────────────────────────────────────────────────

describe("computeDiff", () => {
  it("returns empty array for identical content", () => {
    const result = computeDiff("hello\nworld", "hello\nworld");
    expect(result.filter((l) => l.type !== "context")).toHaveLength(0);
  });

  it("marks added lines", () => {
    const result = computeDiff("a\nb", "a\nb\nc");
    const added = result.filter((l) => l.type === "added");
    expect(added).toHaveLength(1);
    expect((added[0] as { type: string; text: string }).text).toBe("c");
  });

  it("marks removed lines", () => {
    const result = computeDiff("a\nb\nc", "a\nb");
    const removed = result.filter((l) => l.type === "removed");
    expect(removed).toHaveLength(1);
    expect((removed[0] as { type: string; text: string }).text).toBe("c");
  });

  it("returns separator for files over the line limit", () => {
    const big = Array.from({ length: 601 }, (_, i) => `line ${i}`).join("\n");
    const result = computeDiff(big, big);
    expect(result).toEqual([{ type: "separator" }]);
  });
});

// ─── mergeWithConflictMarkers ─────────────────────────────────────────────────

describe("mergeWithConflictMarkers", () => {
  it("returns local content unchanged when files are identical", () => {
    const text = "line one\nline two\n";
    expect(mergeWithConflictMarkers(text, text, "now")).toBe(text);
  });

  it("wraps only the changed hunk in callout blocks, leaving context lines intact", () => {
    const local  = "header\nold line\nfooter";
    const remote = "header\nnew line\nfooter";
    const merged = mergeWithConflictMarkers(local, remote, "ts");

    expect(merged).toContain("header");
    expect(merged).toContain("footer");
    expect(merged).toContain("> [!warning] Conflict — local version");
    expect(merged).toContain("> old line");
    expect(merged).toContain("> [!danger] Conflict — remote version (ts)");
    expect(merged).toContain("> new line");

    // context lines must NOT be inside the callout
    const lines = merged.split("\n");
    const headerIdx = lines.indexOf("header");
    const markerIdx = lines.findIndex((l) => l.includes("[!warning]"));
    expect(headerIdx).toBeLessThan(markerIdx);
  });

  it("prefixes markdown headings correctly so they render inside the callout", () => {
    const local  = "# f";
    const remote = "# e";
    const merged = mergeWithConflictMarkers(local, remote, "ts");

    expect(merged).toContain("> # f");
    expect(merged).toContain("> # e");
  });

  it("handles a remote-only addition", () => {
    const local  = "line one\nline two";
    const remote = "line one\nline two\nline three";
    const merged = mergeWithConflictMarkers(local, remote, "ts");

    expect(merged).toContain("> [!warning] Conflict — local version");
    expect(merged).toContain("> [!danger] Conflict — remote version (ts)");
    expect(merged).toContain("> line three");
  });

  it("handles a local-only addition", () => {
    const local  = "line one\nline two\nlocal only";
    const remote = "line one\nline two";
    const merged = mergeWithConflictMarkers(local, remote, "ts");

    expect(merged).toContain("> local only");
    expect(merged).toContain("> [!warning] Conflict — local version");
    expect(merged).toContain("> [!danger] Conflict — remote version (ts)");
  });

  it("produces multiple independent callout pairs for non-adjacent changes", () => {
    const local  = "a\nB\nc\nD\ne";
    const remote = "a\nb\nc\nd\ne";
    const merged = mergeWithConflictMarkers(local, remote, "ts");

    const warningCount = (merged.match(/\[!warning\]/g) ?? []).length;
    expect(warningCount).toBe(2);
  });

  it("converts empty lines inside a hunk to bare '>' to keep callout intact", () => {
    // The local hunk contains an internal blank line (remote has no blank line,
    // so the LCS cannot pull the empty line out as shared context).
    const local  = "local only\n\nmore local";
    const remote = "remote only";
    const merged = mergeWithConflictMarkers(local, remote, "ts");

    const lines = merged.split("\n");
    expect(lines).toContain(">");          // bare > for the empty line in local hunk
    expect(merged).toContain("> local only");
    expect(merged).toContain("> more local");
    expect(merged).toContain("> remote only");
  });

  it("does not emit an empty callout block when the only difference is a trailing newline", () => {
    const local  = "same content\n";
    const remote = "same content\n\n";
    const merged = mergeWithConflictMarkers(local, remote, "ts");

    expect(merged).not.toContain("[!warning]");
    expect(merged).not.toContain("[!danger]");
  });

  it("falls back to full-append for files over the line limit and still uses callout markers", () => {
    const big = Array.from({ length: 601 }, (_, i) => `line ${i}`).join("\n");
    const merged = mergeWithConflictMarkers(big, "remote", "ts");

    expect(merged).toContain("line 0");
    expect(merged).toContain("> [!warning] Conflict — local version");
    expect(merged).toContain("> [!danger] Conflict — remote version (ts)");
    expect(merged).toContain("> remote");
  });
});
