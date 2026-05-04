/**
 * S3 error codes, typed errors, and classification helpers.
 * Kept separate from s3client.ts so they can be imported by settings and UI
 * without pulling in the full AWS SDK dependency chain.
 */
import type { S3Config } from "../types";

// ─── Error codes ──────────────────────────────────────────────────────────────

/**
 * Structured error codes surfaced in notices so users can look them up.
 * See the README error-code table for troubleshooting guidance.
 */
export const EC = {
  SSO_EXPIRED:    "S3S-E01",
  PROFILE_MOBILE: "S3S-E02",
  NETWORK:        "S3S-E03",
  AUTH:           "S3S-E04",
  NOT_FOUND:      "S3S-E05",
  ACCESS_DENIED:  "S3S-E06",
  UNKNOWN:        "S3S-E99",
} as const;

export function errorField(err: unknown, key: "name" | "message"): string {
  if (err && typeof err === "object") {
    const v = (err as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return "";
}

export function errorCode(err: unknown): string {
  const name = errorField(err, "name");
  const msg  = errorField(err, "message").toLowerCase();
  if (name === "NoSuchBucket")                                           return EC.NOT_FOUND;
  if (name === "AccessDenied" || name === "Forbidden"
      || msg.includes("access denied") || msg.includes("forbidden"))    return EC.ACCESS_DENIED;
  if (name === "InvalidClientTokenId" || name === "AuthFailure"
      || msg.includes("invalid access key") || msg.includes("invalid token")
      || msg.includes("invalid security token"))                         return EC.AUTH;
  if (msg.includes("failed to fetch") || msg.includes("networkerror")
      || msg.includes("network request") || name === "TimeoutError"
      || msg.includes("timed out"))                                      return EC.NETWORK;
  return EC.UNKNOWN;
}

// ─── SSO session error ────────────────────────────────────────────────────────

/**
 * Thrown when an AWS SSO session has expired.
 * `ssoStartUrl` is the portal URL to re-authenticate; null when unresolvable.
 */
export class SSOSessionExpiredError extends Error {
  readonly ssoStartUrl: string | null;
  readonly profileName: string;

  constructor(ssoStartUrl: string | null, profileName: string, cause?: unknown) {
    super(
      `AWS SSO session expired. Run \`aws sso login --profile ${profileName}\` in your terminal, then retry.`
    );
    this.name = "SSOSessionExpiredError";
    this.ssoStartUrl = ssoStartUrl;
    this.profileName = profileName;
    if (cause != null) (this as Record<string, unknown>)["cause"] = cause;
  }
}

/** The exact terminal command a user must run to re-authenticate. Single source of truth. */
export function ssoRelogCommand(profileName: string): string {
  return `aws sso login --profile ${profileName}`;
}

// ─── Security helpers ─────────────────────────────────────────────────────────

/** Access Key ID pattern for long-term (AKIA) and session (ASIA) credentials */
const ACCESS_KEY_RE = /^(AKIA|ASIA|AROA|AIDA)[0-9A-Z]{16}$/;

export function validateAccessKeyId(key: string): string | null {
  if (!key) return "Access Key ID is required.";
  if (!ACCESS_KEY_RE.test(key)) return "Access Key ID does not match the expected AWS format (e.g. AKIAIOSFODNN7EXAMPLE).";
  return null;
}

/** Redact credentials from error messages before surfacing them to the user. */
export function redactCredentials(msg: string, cfg: S3Config): string {
  let out = msg;
  if (cfg.s3AccessKeyID) out = out.replaceAll(cfg.s3AccessKeyID, "[ACCESS_KEY]");
  if (cfg.s3SecretAccessKey) out = out.replaceAll(cfg.s3SecretAccessKey, "[SECRET_KEY]");
  return out;
}

/** Detect errors that indicate an expired or missing SSO token. */
export function isSSOExpiredError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = errorField(err, "name");
  const msg = errorField(err, "message").toLowerCase();
  return (
    name === "SSOTokenProviderFailure" ||
    name === "ExpiredTokenException" ||
    name === "UnauthorizedException" ||
    (msg.includes("sso") && msg.includes("token")) ||
    (msg.includes("sso") && msg.includes("session")) ||
    (msg.includes("token") && msg.includes("expir")) ||
    (msg.includes("session") && msg.includes("expir"))
  );
}
