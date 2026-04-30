import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
// Static import — avoids the CJS-interop bug that occurred with dynamic await import()
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { HttpHandlerOptions } from "@aws-sdk/types";
import { FetchHttpHandler, type FetchHttpHandlerOptions } from "@smithy/fetch-http-handler";
import { HttpResponse, type HttpRequest } from "@smithy/protocol-http";
import { buildQueryString } from "@smithy/querystring-builder";
import { Platform, type RequestUrlParam, requestUrl } from "obsidian";
import type { RemoteObject, S3Config } from "./types";

// ─── Constants ────────────────────────────────────────────────────────────────

const MULTIPART_THRESHOLD = 5 * 1024 * 1024; // 5 MB

/** Access Key ID pattern for long-term (AKIA) and session (ASIA) credentials */
const ACCESS_KEY_RE = /^(AKIA|ASIA|AROA|AIDA)[0-9A-Z]{16}$/;

// ─── Typed access to Node.js require in Electron ─────────────────────────────
// fs/os/path are external in the esbuild bundle and resolve to native Node.js
// modules at runtime inside Obsidian desktop (Electron).  This helper avoids
// TypeScript errors while being explicit about the runtime requirement.

function nodeRequire(id: string): unknown {
  // eslint-disable-next-line obsidianmd/prefer-active-doc -- accessing Electron's CommonJS require, not the document
  const rq = (globalThis as Record<string, unknown>)["require"];
  if (typeof rq !== "function") throw new Error(`require("${id}") is not available outside Electron.`);
  return (rq as (id: string) => unknown)(id);
}

// ─── Error codes ─────────────────────────────────────────────────────────────

/**
 * Structured error codes surfaced in notices/errors so users can look them up.
 * See the README error-code table for troubleshooting guidance.
 */
export const EC = {
  SSO_EXPIRED:       "S3S-E01",
  PROFILE_MOBILE:    "S3S-E02",
  NETWORK:           "S3S-E03",
  AUTH:              "S3S-E04",
  NOT_FOUND:         "S3S-E05",
  ACCESS_DENIED:     "S3S-E06",
  UNKNOWN:           "S3S-E99",
} as const;

function errorField(err: unknown, key: "name" | "message"): string {
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
 * `ssoStartUrl` is the URL to open in a browser to re-authenticate;
 * it is null when the URL could not be read from ~/.aws/config.
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

// ─── Security helpers ─────────────────────────────────────────────────────────

/**
 * Validate that an Access Key ID matches the AWS format.
 * Catches obvious copy-paste mistakes before they result in confusing auth errors.
 */
export function validateAccessKeyId(key: string): string | null {
  if (!key) return "Access Key ID is required.";
  if (!ACCESS_KEY_RE.test(key)) return "Access Key ID does not match the expected AWS format (e.g. AKIAIOSFODNN7EXAMPLE).";
  return null;
}

/**
 * Redact credentials from error messages before surfacing them to the user.
 * AWS SDK errors occasionally echo request details that contain signing headers.
 */
function redactCredentials(msg: string, cfg: S3Config): string {
  let out = msg;
  if (cfg.s3AccessKeyID) out = out.replaceAll(cfg.s3AccessKeyID, "[ACCESS_KEY]");
  if (cfg.s3SecretAccessKey) out = out.replaceAll(cfg.s3SecretAccessKey, "[SECRET_KEY]");
  return out;
}

// ─── SSO helpers ──────────────────────────────────────────────────────────────

/** Detect errors that indicate an expired or missing SSO token. */
function isSSOExpiredError(err: unknown): boolean {
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

/**
 * Read `~/.aws/config` and return the `sso_start_url` for the given profile.
 * Handles both the legacy format (direct `sso_start_url` under [profile ...])
 * and the modern format (profile → `sso_session` → [sso-session ...] block).
 * Returns null when the URL cannot be determined or the platform is not desktop.
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

    const profileHeader =
      profileName === "default" ? "[default]" : `[profile ${profileName}]`;

    let inSection = false;
    let ssoSessionName: string | null = null;
    let directSsoStartUrl: string | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[")) {
        inSection = trimmed === profileHeader;
        continue;
      }
      if (!inSection || !trimmed || trimmed.startsWith("#")) continue;

      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();

      if (key === "sso_session") ssoSessionName = val;
      if (key === "sso_start_url") directSsoStartUrl = val;
    }

    // Modern format: profile references a [sso-session <name>] block
    if (ssoSessionName) {
      const sessionHeader = `[sso-session ${ssoSessionName}]`;
      let inSession = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("[")) {
          inSession = trimmed === sessionHeader;
          continue;
        }
        if (!inSession || !trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        if (trimmed.slice(0, eqIdx).trim() === "sso_start_url") {
          return trimmed.slice(eqIdx + 1).trim();
        }
      }
    }

    return directSsoStartUrl;
  } catch {
    return null;
  }
}

export type SSOLoginCallback = (result: { url: string; code?: string }) => void;

/**
 * Launch `aws sso login --profile <name>` and stream output back via `onUrl`.
 *
 * The caller is responsible for opening the browser — electron.shell is a
 * main-process API and is not reliably accessible from the renderer; routing
 * through the plugin's `openExternalBrowser` helper is the correct path.
 *
 * A 15-second fallback fires the callback with the SSO start URL read from
 * ~/.aws/config if the subprocess never emits a device-code URL (e.g. the aws
 * CLI is not installed or takes too long to produce output).
 */
export function launchSSOLogin(profileName: string, onUrl?: SSOLoginCallback): boolean {
  if (!Platform.isDesktop) return false;
  try {
    const cp = nodeRequire("child_process") as {
      spawn: (cmd: string, args: string[], opts: object) => {
        stdout: { on: (event: "data", cb: (chunk: { toString: () => string }) => void) => void };
        stderr: { on: (event: "data", cb: (chunk: { toString: () => string }) => void) => void };
        on: (event: "close", cb: () => void) => void;
        unref: () => void;
      };
    };

    const proc = cp.spawn(
      "aws",
      ["sso", "login", "--profile", profileName || "default"],
      {
        shell: true,   // lets /bin/sh resolve Homebrew/pyenv/asdf installs
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let urlFound = false;
    let accum = "";

    // Fallback: if the subprocess hasn't emitted a URL after 15 s, open the
    // SSO start URL straight from ~/.aws/config so the user isn't left waiting.
    const fallback = activeWindow.setTimeout(() => {
      if (urlFound) return;
      const startUrl = parseAWSConfigForSSO(profileName || "default");
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

/**
 * Centralised error re-throw: detect SSO expiry first, fall back to a
 * redacted error prefixed with a lookup code. Always throws.
 */
function rethrowMapped(err: unknown, cfg: S3Config): never {
  if (cfg.authMethod === "profile" && isSSOExpiredError(err)) {
    const profileName = cfg.s3ProfileName || "default";
    const url = parseAWSConfigForSSO(profileName);
    throw new SSOSessionExpiredError(url, profileName, err);
  }
  const rawMsg = err instanceof Error ? err.message : errorField(err, "message") || String(err);
  const code = errorCode(err);
  throw new Error(`[${code}] ${redactCredentials(rawMsg, cfg)}`);
}

// ─── Inline MIME type lookup ──────────────────────────────────────────────────
// Avoids pulling in the `mime-types` package (which requires the `path` built-in)
// while still producing sensible Content-Type headers for common Obsidian assets.

const MIME_MAP: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  json: "application/json",
  canvas: "application/json",
  css: "text/css",
  html: "text/html",
  js: "application/javascript",
  ts: "text/plain",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  webm: "video/webm",
  wav: "audio/wav",
  excalidraw: "application/json",
};

function getContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_MAP[ext] ?? "application/octet-stream";
}

// ─── Obsidian HTTP Handler ────────────────────────────────────────────────────
// Obsidian desktop blocks direct cross-origin fetch calls to arbitrary S3
// endpoints.  By routing through Obsidian's `requestUrl` (backed by Electron's
// net module) we bypass those CORS restrictions without needing a proxy.

function makeTimeoutPromise(ms: number | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (ms == null) return; // never settles → no-op in Promise.race
    activeWindow.setTimeout(() => {
      const e = new Error(`Request timed out after ${ms}ms`);
      e.name = "TimeoutError";
      reject(e);
    }, ms);
  });
}

class ObsHttpHandler extends FetchHttpHandler {
  private timeoutMs: number | undefined;

  constructor(options?: FetchHttpHandlerOptions) {
    super(options);
    this.timeoutMs = options?.requestTimeout;
  }

  async handle(
    request: HttpRequest,
    { abortSignal }: HttpHandlerOptions = {}
  ): Promise<{ response: HttpResponse }> {
    if (abortSignal?.aborted) {
      const e = new Error("Request aborted");
      e.name = "AbortError";
      return Promise.reject(e);
    }

    let reqPath = request.path;
    if (request.query) {
      const qs = buildQueryString(request.query);
      if (qs) reqPath += `?${qs}`;
    }

    const { port, method } = request;
    const url = `${request.protocol}//${request.hostname}${port ? `:${port}` : ""}${reqPath}`;
    const rawBody: unknown = method === "GET" || method === "HEAD" ? undefined : request.body;

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) {
      const lk = k.toLowerCase();
      // Obsidian's requestUrl sets host and content-length automatically
      if (lk === "host" || lk === "content-length") continue;
      headers[lk] = v;
    }

    let body: unknown = rawBody;
    if (ArrayBuffer.isView(rawBody)) {
      body = rawBody.buffer.slice(
        rawBody.byteOffset,
        rawBody.byteOffset + rawBody.byteLength
      );
    }

    const param: RequestUrlParam = {
      body: body as RequestUrlParam["body"],
      headers,
      method,
      url,
      contentType: headers["content-type"],
    };

    const requestPromise = requestUrl(param).then((rsp) => {
      const lower: Record<string, string> = {};
      for (const [k, v] of Object.entries(rsp.headers)) lower[k.toLowerCase()] = v;
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new Uint8Array(rsp.arrayBuffer));
          ctrl.close();
        },
      });
      return {
        response: new HttpResponse({ headers: lower, statusCode: rsp.status, body: stream }),
      };
    });

    const races: Promise<{ response: HttpResponse }>[] = [requestPromise, makeTimeoutPromise(this.timeoutMs)];
    if (abortSignal) {
      races.push(
        new Promise<never>((_, reject) => {
          abortSignal.onabort = () => {
            const e = new Error("Request aborted");
            e.name = "AbortError";
            reject(e);
          };
        })
      );
    }
    return Promise.race(races);
  }
}

// ─── Credential resolution ────────────────────────────────────────────────────

function resolveCredentials(cfg: S3Config) {
  if (cfg.authMethod === "profile") {
    if (!Platform.isDesktop) {
      throw new Error(
        `[${EC.PROFILE_MOBILE}] AWS named-profile authentication is only available on desktop. ` +
          "Use static credentials on mobile."
      );
    }
    // fromNodeProviderChain returns a credential provider (lazy function) that
    // handles the full AWS credential chain: SSO, assume-role, MFA, env vars, etc.
    // The S3Client calls it on each request, which enables automatic token refresh.
    // fs/os/path are external in the bundle so they resolve to native Node.js in Electron.
    return fromNodeProviderChain({ profile: cfg.s3ProfileName || "default" });
  }

  // Return static credentials as-is; the SDK will surface auth errors at
  // request time, which means an unconfigured plugin still loads successfully.
  return {
    accessKeyId: cfg.s3AccessKeyID,
    secretAccessKey: cfg.s3SecretAccessKey,
  };
}

// ─── S3Client factory ─────────────────────────────────────────────────────────

function buildS3Client(cfg: S3Config): S3Client {
  let endpoint = cfg.s3Endpoint.trim();
  if (endpoint && !endpoint.startsWith("http://") && !endpoint.startsWith("https://")) {
    endpoint = `https://${endpoint}`;
  }

  const credentials = resolveCredentials(cfg);

  const clientOptions: ConstructorParameters<typeof S3Client>[0] = {
    region: cfg.s3Region || "us-east-1",
    forcePathStyle: cfg.forcePathStyle,
    credentials,
  };

  if (endpoint) clientOptions.endpoint = endpoint;

  // Use Obsidian's requestUrl to bypass CORS on desktop
  if (Platform.isDesktop) {
    clientOptions.requestHandler = new ObsHttpHandler({ requestTimeout: 30_000 });
  }

  const client = new S3Client(clientOptions);

  // Disable caching so we always receive fresh object listings
  client.middlewareStack.add(
    (next) => (args) => {
      (args.request as Record<string, unknown>)["headers"] = {
        ...(args.request as Record<string, unknown>)["headers"] as Record<string, string>,
        "cache-control": "no-cache",
      };
      return next(args);
    },
    { step: "build" }
  );

  return client;
}

async function streamToArrayBuffer(body: ReadableStream | Blob | undefined): Promise<ArrayBuffer> {
  if (!body) throw new Error("Empty response body from S3.");
  if (body instanceof Blob) return body.arrayBuffer();
  return new Response(body).arrayBuffer();
}

// ─── Public API ───────────────────────────────────────────────────────────────

export class S3ClientWrapper {
  private cfg: S3Config;
  private _client: S3Client;

  constructor(cfg: S3Config) {
    this.cfg = cfg;
    this._client = buildS3Client(cfg);
  }

  private get c(): S3Client {
    return this._client;
  }

  get prefix(): string {
    const p = this.cfg.s3Prefix.trim();
    if (!p) return "";
    return p.endsWith("/") ? p : `${p}/`;
  }

  vaultKeyToS3Key(vaultKey: string): string {
    return `${this.prefix}${vaultKey}`;
  }

  s3KeyToVaultKey(s3Key: string): string {
    return s3Key.startsWith(this.prefix) ? s3Key.slice(this.prefix.length) : s3Key;
  }

  /** List all objects under the configured prefix */
  async listObjects(): Promise<RemoteObject[]> {
    const objects: RemoteObject[] = [];
    let continuationToken: string | undefined;

    try {
      do {
        const cmd = new ListObjectsV2Command({
          Bucket: this.cfg.s3BucketName,
          Prefix: this.prefix || undefined,
          ContinuationToken: continuationToken,
        });
        const rsp = await this.c.send(cmd);

        for (const obj of rsp.Contents ?? []) {
          if (!obj.Key || obj.Key.endsWith("/")) continue;
          objects.push({
            vaultKey: this.s3KeyToVaultKey(obj.Key),
            s3Key: obj.Key,
            etag: (obj.ETag ?? "").replace(/"/g, ""),
            lastModified: obj.LastModified ?? new Date(0),
            size: obj.Size ?? 0,
          });
        }

        continuationToken = rsp.IsTruncated ? rsp.NextContinuationToken : undefined;
      } while (continuationToken);
    } catch (err: unknown) {
      rethrowMapped(err, this.cfg);
    }

    return objects;
  }

  /** Download an object's content */
  async getObject(s3Key: string): Promise<ArrayBuffer> {
    try {
      const rsp = await this.c.send(
        new GetObjectCommand({ Bucket: this.cfg.s3BucketName, Key: s3Key })
      );
      return streamToArrayBuffer(rsp.Body as ReadableStream | Blob | undefined);
    } catch (err: unknown) {
      rethrowMapped(err, this.cfg);
    }
  }

  /**
   * Upload an object.  Files > 5 MB use the multipart API automatically
   * so that large attachments don't hit S3's 5 GB single-PUT limit.
   * Returns the ETag of the uploaded object.
   */
  async putObject(s3Key: string, data: ArrayBuffer, mtime?: number): Promise<string> {
    const contentType = getContentType(s3Key.split("/").pop() ?? "");
    const metadata: Record<string, string> = {};
    if (mtime != null) metadata["x-amz-meta-mtime"] = String(mtime);

    try {
      if (data.byteLength > MULTIPART_THRESHOLD) {
        const upload = new Upload({
          client: this.c,
          params: {
            Bucket: this.cfg.s3BucketName,
            Key: s3Key,
            Body: new Uint8Array(data),
            ContentType: contentType,
            Metadata: metadata,
          },
        });
        const result = await upload.done();
        return (result.ETag ?? "").replace(/"/g, "");
      }

      const rsp = await this.c.send(
        new PutObjectCommand({
          Bucket: this.cfg.s3BucketName,
          Key: s3Key,
          Body: new Uint8Array(data),
          ContentType: contentType,
          Metadata: metadata,
        })
      );
      return (rsp.ETag ?? "").replace(/"/g, "");
    } catch (err: unknown) {
      rethrowMapped(err, this.cfg);
    }
  }

  /** Delete an object */
  async deleteObject(s3Key: string): Promise<void> {
    try {
      await this.c.send(
        new DeleteObjectCommand({ Bucket: this.cfg.s3BucketName, Key: s3Key })
      );
    } catch (err: unknown) {
      rethrowMapped(err, this.cfg);
    }
  }

  /** Verify connectivity — throws on failure with redacted error message */
  async testConnection(): Promise<void> {
    try {
      await this.c.send(
        new ListObjectsV2Command({
          Bucket: this.cfg.s3BucketName,
          MaxKeys: 1,
          Prefix: this.prefix || undefined,
        })
      );
    } catch (err: unknown) {
      rethrowMapped(err, this.cfg);
    }
  }

  /** The configured auth method */
  get authMethod() {
    return this.cfg.authMethod;
  }
}
