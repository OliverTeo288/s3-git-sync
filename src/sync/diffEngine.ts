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

/**
 * Compute a unified diff between two strings.
 * Returns a separator-only array when either side exceeds 600 lines (too large to diff inline).
 * Context window is 3 lines around each change.
 */
export function computeDiff(aText: string, bText: string): DiffLine[] {
  const aLines = aText.split("\n");
  const bLines = bText.split("\n");
  const m = aLines.length, n = bLines.length;

  if (m > 600 || n > 600) return [{ type: "separator" }];

  // LCS DP table (Uint16Array saves memory; values ≤ 600 fit safely)
  const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = aLines[i - 1] === bLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const edits: Array<{ op: "=" | "+" | "-"; text: string }> = [];
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
