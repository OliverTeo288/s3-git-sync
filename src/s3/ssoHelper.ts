/**
 * AWS SSO helpers: config parsing and CLI login orchestration.
 * Desktop-only — all exported functions return early or throw on mobile.
 */
import { Platform } from "obsidian";
import { assertSafeProfileName, nodeRequire } from "../utils";

export type SSOLoginCallback = (result: { url: string; code?: string }) => void;

// ─── Config parsing ───────────────────────────────────────────────────────────

/**
 * Read `~/.aws/config` and return the `sso_start_url` for the given profile.
 * Handles both the legacy format (direct `sso_start_url` under [profile ...])
 * and the modern format (profile → `sso_session` → [sso-session ...] block).
 */
export function parseAWSConfigForSSO(profileName: string): string | null {
  if (!Platform.isDesktop) return null;
  try {
    const os = nodeRequire("os") as { homedir: () => string };
    const fs = nodeRequire("fs") as {
      existsSync: (p: string) => boolean;
      readFileSync: (p: string, enc: string) => string;
    };
    const nodePath = nodeRequire("path") as { join: (...parts: string[]) => string };

    const configPath = nodePath.join(os.homedir(), ".aws", "config");
    if (!fs.existsSync(configPath)) return null;

    const lines = fs.readFileSync(configPath, "utf8").split("\n");
    return extractSSOStartUrl(lines, profileName);
  } catch {
    return null;
  }
}

function extractSSOStartUrl(lines: string[], profileName: string): string | null {
  const profileHeader =
    profileName === "default" ? "[default]" : `[profile ${profileName}]`;

  let inSection = false;
  let ssoSessionName: string | null = null;
  let directSsoStartUrl: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) { inSection = trimmed === profileHeader; continue; }
    if (!inSection || !trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();

    if (key === "sso_session") ssoSessionName = val;
    if (key === "sso_start_url") directSsoStartUrl = val;
  }

  if (ssoSessionName) {
    return findSSOSessionUrl(lines, ssoSessionName) ?? directSsoStartUrl;
  }
  return directSsoStartUrl;
}

function findSSOSessionUrl(lines: string[], sessionName: string): string | null {
  const header = `[sso-session ${sessionName}]`;
  let inSession = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) { inSession = trimmed === header; continue; }
    if (!inSession || !trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    if (trimmed.slice(0, eqIdx).trim() === "sso_start_url") {
      return trimmed.slice(eqIdx + 1).trim();
    }
  }
  return null;
}

// ─── CLI login launcher ───────────────────────────────────────────────────────

/**
 * Launch `aws sso login --profile <name>` and stream output back via `onUrl`.
 * Returns false if not on desktop or if the CLI cannot be spawned.
 *
 * A 15-second fallback fires the callback with the SSO start URL from
 * ~/.aws/config if the subprocess never emits a device-code URL.
 */
export function launchSSOLogin(profileName: string, onUrl?: SSOLoginCallback): boolean {
  if (!Platform.isDesktop) return false;
  const safeName = profileName || "default";
  // Profile names flow into spawn args; reject anything outside the AWS-allowed
  // character set so a malicious settings value can never become a shell token.
  try { assertSafeProfileName(safeName); } catch { return false; }
  try {
    const cp = nodeRequire("child_process") as {
      spawn: (cmd: string, args: string[], opts: object) => {
        stdout: { on: (event: "data", cb: (chunk: { toString: () => string }) => void) => void };
        stderr: { on: (event: "data", cb: (chunk: { toString: () => string }) => void) => void };
        on: (event: "close", cb: () => void) => void;
        unref: () => void;
      };
    };

    // No `shell: true` — `aws` resolves on PATH and args go straight to argv,
    // so shell metacharacters in the profile name (already filtered above)
    // can never be re-parsed.
    const proc = cp.spawn(
      "aws",
      ["sso", "login", "--profile", safeName],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );

    let urlFound = false;
    let accum = "";

    const fallback = activeWindow.setTimeout(() => {
      if (urlFound) return;
      const startUrl = parseAWSConfigForSSO(safeName);
      if (startUrl) { urlFound = true; onUrl?.({ url: startUrl }); }
    }, 15_000);

    const handleChunk = (chunk: { toString: () => string }) => {
      // Strip ANSI colour codes before parsing.
      // eslint-disable-next-line no-control-regex -- ESC byte is required to match terminal escape sequences
      accum += chunk.toString().replace(/\x1b\[[0-9;]*[mGKHF]/g, "");
      if (urlFound) return;

      const urlMatch = accum.match(/https?:\/\/[^\s]+/);
      if (!urlMatch) return;

      urlFound = true;
      activeWindow.clearTimeout(fallback);
      const url = urlMatch[0].replace(/[.,;:)\]'"]+$/, "").trim();
      const codeMatch = accum.match(/(?:enter the code|user[_ ]code)[:\s]+([A-Z]{4}-[A-Z]{4})/i);
      onUrl?.({ url, code: codeMatch?.[1] });
    };

    proc.stdout.on("data", handleChunk);
    proc.stderr.on("data", handleChunk);
    proc.on("close", () => activeWindow.clearTimeout(fallback));
    proc.unref();
    return true;
  } catch {
    return false;
  }
}
