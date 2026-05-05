/**
 * Text diff engine: LCS-based line diff with context-window output.
 * Pure computation — no DOM, no Obsidian API dependencies.
 */

export type DiffLine =
  | { type: "added" | "removed" | "context"; text: string }
  | { type: "separator" };

const TEXT_EXTS = new Set([
  "md", "txt", "json", "canvas", "excalidraw", "csv",
  "js", "ts", "jsx", "tsx", "html", "css", "scss",
  "yaml", "yml", "toml", "sh", "bash", "py", "go",
  "java", "c", "cpp", "h", "rs", "xml", "svg",
]);

export function isTextFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTS.has(ext);
}

// ─── LCS core ─────────────────────────────────────────────────────────────────

const MAX_LCS_LINES = 600;

type RawEdit = { op: "=" | "+" | "-"; text: string };

/**
 * Compute the raw LCS edit script between two line arrays.
 * Returns `null` when either side exceeds MAX_LCS_LINES (too expensive to diff).
 */
function computeEdits(aLines: string[], bLines: string[]): RawEdit[] | null {
  const m = aLines.length, n = bLines.length;
  if (m > MAX_LCS_LINES || n > MAX_LCS_LINES) return null;

  // LCS DP table (Uint16Array saves memory; values ≤ 600 fit safely)
  const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = aLines[i - 1] === bLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const edits: RawEdit[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      edits.unshift({ op: "=", text: aLines[i - 1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      edits.unshift({ op: "+", text: bLines[j - 1] }); j--;
    } else {
      edits.unshift({ op: "-", text: aLines[i - 1] }); i--;
    }
  }

  // Drop trailing empty "same" line (artefact of split on final newline)
  while (edits.length > 0 && edits[edits.length - 1].op === "=" && edits[edits.length - 1].text === "") {
    edits.pop();
  }

  return edits;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute a unified diff between two strings for display.
 * Returns a separator-only array when either side exceeds MAX_LCS_LINES.
 * Context window is 3 lines around each change.
 */
export function computeDiff(aText: string, bText: string): DiffLine[] {
  const aLines = aText.split("\n");
  const bLines = bText.split("\n");

  const edits = computeEdits(aLines, bLines);
  if (!edits) return [{ type: "separator" }];

  const CONTEXT = 3;
  const len = edits.length;
  const include = new Uint8Array(len);
  for (let k = 0; k < len; k++) {
    if (edits[k].op !== "=") {
      const lo = Math.max(0, k - CONTEXT);
      const hi = Math.min(len - 1, k + CONTEXT);
      for (let d = lo; d <= hi; d++) include[d] = 1;
    }
  }

  const result: DiffLine[] = [];
  for (let k = 0; k < len; k++) {
    if (!include[k]) continue;
    if (k > 0 && !include[k - 1]) result.push({ type: "separator" });
    const { op, text } = edits[k];
    result.push(
      op === "=" ? { type: "context", text }
        : op === "+" ? { type: "added", text }
        : { type: "removed", text }
    );
  }
  return result;
}

/**
 * Merge local and remote text using Obsidian callout blocks so the content
 * renders correctly in Obsidian's reading view (headings, bold, etc. all
 * display as expected inside a callout).
 *
 * Each differing hunk is wrapped as two adjacent callout blocks:
 *
 * ```markdown
 * > [!warning] Conflict — local version
 * > [local lines]
 *
 * > [!danger] Conflict — remote version (timestamp)
 * > [remote lines]
 * ```
 *
 * Unchanged lines pass through untouched.
 * Falls back to full-append when either file exceeds MAX_LCS_LINES.
 */
export function mergeWithConflictMarkers(localText: string, remoteText: string, label: string): string {
  const localLines = localText.split("\n");
  const remoteLines = remoteText.split("\n");

  const edits = computeEdits(localLines, remoteLines);

  // LCS too expensive for large files — fall back to full-append using callouts
  if (!edits) {
    return (
      `${localText}\n\n` +
      `> [!warning] Conflict — local version\n\n` +
      `> [!danger] Conflict — remote version (${label})\n` +
      remoteLines.map((l) => (l === "" ? ">" : `> ${l}`)).join("\n") + "\n"
    );
  }

  // Identical content — no markers needed
  if (edits.every((e) => e.op === "=")) return localText;

  /** Prefix each line for a callout block; empty lines use bare `>` to continue the block. */
  const toCallout = (lines: string[]) => lines.map((l) => (l === "" ? ">" : `> ${l}`));

  const out: string[] = [];
  let i = 0;
  while (i < edits.length) {
    if (edits[i].op === "=") {
      out.push(edits[i].text);
      i++;
    } else {
      // Collect all consecutive non-context lines as one conflict hunk
      const localHunk: string[] = [];
      const remoteHunk: string[] = [];
      while (i < edits.length && edits[i].op !== "=") {
        if (edits[i].op === "-") localHunk.push(edits[i].text);
        else remoteHunk.push(edits[i].text);
        i++;
      }
      // Skip hunks that differ only in trailing blank lines — not worth surfacing.
      const hasContent = (lines: string[]) => lines.some((l) => l.trim() !== "");
      if (!hasContent(localHunk) && !hasContent(remoteHunk)) continue;

      // Blank line before the block so Obsidian doesn't merge it with preceding text
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      out.push("> [!warning] Conflict — local version");
      out.push(...toCallout(localHunk));
      out.push(""); // blank line separates the two callout blocks
      out.push(`> [!danger] Conflict — remote version (${label})`);
      out.push(...toCallout(remoteHunk));
      out.push(""); // blank line after the block
    }
  }
  return out.join("\n");
}
