import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
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
import { EC, SSOSessionExpiredError, errorField, errorCode, isSSOExpiredError, redactCredentials, validateAccessKeyId } from "./errors";
import { parseAWSConfigForSSO } from "./ssoHelper";
import type { ObjectVersion, RemoteObject, S3Config } from "../types";

export { EC, SSOSessionExpiredError, validateAccessKeyId };
export type { SSOLoginCallback } from "./ssoHelper";
export { parseAWSConfigForSSO, launchSSOLogin } from "./ssoHelper";

// ─── Constants ────────────────────────────────────────────────────────────────

const MULTIPART_THRESHOLD = 5 * 1024 * 1024; // 5 MB

// ─── Inline MIME type lookup ──────────────────────────────────────────────────
// Avoids pulling in the `mime-types` package while still producing sensible
// Content-Type headers for common Obsidian assets.

const MIME_MAP: Record<string, string> = {
  md: "text/markdown", txt: "text/plain", pdf: "application/pdf",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", svg: "image/svg+xml", webp: "image/webp",
  json: "application/json", canvas: "application/json",
  css: "text/css", html: "text/html", js: "application/javascript",
  ts: "text/plain", mp3: "audio/mpeg", mp4: "video/mp4",
  webm: "video/webm", wav: "audio/wav", excalidraw: "application/json",
};

function getContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_MAP[ext] ?? "application/octet-stream";
}

function stripEtagQuotes(etag: string): string {
  return etag.replace(/"/g, "");
}

// ─── Error mapping ────────────────────────────────────────────────────────────

function rethrowMapped(err: unknown, cfg: S3Config): never {
  if (cfg.authMethod === "profile" && isSSOExpiredError(err)) {
    const profileName = cfg.s3ProfileName || "default";
    throw new SSOSessionExpiredError(parseAWSConfigForSSO(profileName), profileName, err);
  }
  const rawMsg = err instanceof Error ? err.message : errorField(err, "message") || String(err);
  throw new Error(`[${errorCode(err)}] ${redactCredentials(rawMsg, cfg)}`);
}

// ─── Obsidian HTTP handler ────────────────────────────────────────────────────
// Routes S3 requests through Obsidian's `requestUrl` (backed by Electron's
// net module) to bypass CORS restrictions on desktop without needing a proxy.

/**
 * Returns a never-resolving promise plus a `cancel` to clear the timer.
 * Without `cancel()` the timer leaks per request — `Promise.race` decides a
 * winner but the loser stays scheduled until `ms` elapses.
 */
function makeTimeoutPromise(ms: number | undefined): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof activeWindow.setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    if (ms == null) return;
    timer = activeWindow.setTimeout(() => {
      const e = new Error(`Request timed out after ${ms}ms`);
      e.name = "TimeoutError";
      reject(e);
    }, ms);
  });
  return { promise, cancel: () => { if (timer != null) activeWindow.clearTimeout(timer); } };
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
      return Promise.reject(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
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
      body = rawBody.buffer.slice(rawBody.byteOffset, rawBody.byteOffset + rawBody.byteLength);
    }

    const requestPromise = requestUrl({
      body: body as RequestUrlParam["body"],
      headers,
      method,
      url,
      contentType: headers["content-type"],
    }).then((rsp) => {
      const lower: Record<string, string> = {};
      for (const [k, v] of Object.entries(rsp.headers)) lower[k.toLowerCase()] = v;
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) { ctrl.enqueue(new Uint8Array(rsp.arrayBuffer)); ctrl.close(); },
      });
      return { response: new HttpResponse({ headers: lower, statusCode: rsp.status, body: stream }) };
    });

    const timeout = makeTimeoutPromise(this.timeoutMs);
    const races: Promise<{ response: HttpResponse }>[] = [requestPromise, timeout.promise];
    if (abortSignal) {
      // Use addEventListener (DOM AbortSignal) so we don't clobber a handler
      // the SDK may have set. The SDK's narrowed interface omits it; cast up.
      const dom = abortSignal as unknown as AbortSignal;
      races.push(new Promise<never>((_, reject) => {
        dom.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("Request aborted"), { name: "AbortError" })),
          { once: true },
        );
      }));
    }
    try { return await Promise.race(races); }
    finally { timeout.cancel(); }
  }
}

// ─── Client factory ───────────────────────────────────────────────────────────

function resolveCredentials(cfg: S3Config) {
  if (cfg.authMethod === "profile") {
    if (!Platform.isDesktop) {
      throw new Error(
        `[${EC.PROFILE_MOBILE}] AWS named-profile authentication is only available on desktop. ` +
          "Use static credentials on mobile."
      );
    }
    // fromNodeProviderChain handles SSO, assume-role, MFA, env vars and auto token refresh.
    return fromNodeProviderChain({ profile: cfg.s3ProfileName || "default" });
  }
  return { accessKeyId: cfg.s3AccessKeyID, secretAccessKey: cfg.s3SecretAccessKey };
}

function buildS3Client(cfg: S3Config): S3Client {
  let endpoint = cfg.s3Endpoint.trim();
  if (endpoint && !endpoint.startsWith("http://") && !endpoint.startsWith("https://")) {
    endpoint = `https://${endpoint}`;
  }

  const clientOptions: ConstructorParameters<typeof S3Client>[0] = {
    region: cfg.s3Region || "us-east-1",
    forcePathStyle: cfg.forcePathStyle,
    credentials: resolveCredentials(cfg),
  };
  if (endpoint) clientOptions.endpoint = endpoint;
  // Use Obsidian's requestUrl to bypass CORS on desktop
  if (Platform.isDesktop) clientOptions.requestHandler = new ObsHttpHandler({ requestTimeout: 30_000 });

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

  private get c(): S3Client { return this._client; }

  get prefix(): string {
    const p = this.cfg.s3Prefix.trim();
    if (!p) return "";
    return p.endsWith("/") ? p : `${p}/`;
  }

  vaultKeyToS3Key(vaultKey: string): string { return `${this.prefix}${vaultKey}`; }
  s3KeyToVaultKey(s3Key: string): string {
    return s3Key.startsWith(this.prefix) ? s3Key.slice(this.prefix.length) : s3Key;
  }

  async listObjects(): Promise<RemoteObject[]> {
    const objects: RemoteObject[] = [];
    let continuationToken: string | undefined;
    try {
      do {
        const rsp = await this.c.send(new ListObjectsV2Command({
          Bucket: this.cfg.s3BucketName,
          Prefix: this.prefix || undefined,
          ContinuationToken: continuationToken,
        }));
        for (const obj of rsp.Contents ?? []) {
          if (!obj.Key || obj.Key.endsWith("/")) continue;
          objects.push({
            vaultKey: this.s3KeyToVaultKey(obj.Key),
            s3Key: obj.Key,
            etag: stripEtagQuotes(obj.ETag ?? ""),
            lastModified: obj.LastModified ?? new Date(0),
            size: obj.Size ?? 0,
          });
        }
        continuationToken = rsp.IsTruncated ? rsp.NextContinuationToken : undefined;
      } while (continuationToken);
    } catch (err: unknown) { rethrowMapped(err, this.cfg); }
    return objects;
  }

  async getObject(s3Key: string): Promise<ArrayBuffer> {
    try {
      const rsp = await this.c.send(new GetObjectCommand({ Bucket: this.cfg.s3BucketName, Key: s3Key }));
      return streamToArrayBuffer(rsp.Body as ReadableStream | Blob | undefined);
    } catch (err: unknown) { rethrowMapped(err, this.cfg); }
  }

  /**
   * Upload an object. Files > 5 MB use the multipart API automatically
   * so large attachments don't hit S3's 5 GB single-PUT limit.
   * Returns the ETag of the uploaded object.
   */
  async putObject(s3Key: string, data: ArrayBuffer, mtime?: number): Promise<string> {
    const contentType = getContentType(s3Key.split("/").pop() ?? "");
    const metadata: Record<string, string> = {};
    if (mtime != null) metadata["x-amz-meta-mtime"] = String(mtime);
    try {
      if (data.byteLength > MULTIPART_THRESHOLD) {
        const result = await new Upload({
          client: this.c,
          params: { Bucket: this.cfg.s3BucketName, Key: s3Key, Body: new Uint8Array(data), ContentType: contentType, Metadata: metadata },
        }).done();
        return stripEtagQuotes(result.ETag ?? "");
      }
      const rsp = await this.c.send(new PutObjectCommand({
        Bucket: this.cfg.s3BucketName, Key: s3Key, Body: new Uint8Array(data),
        ContentType: contentType, Metadata: metadata,
      }));
      return stripEtagQuotes(rsp.ETag ?? "");
    } catch (err: unknown) { rethrowMapped(err, this.cfg); }
  }

  async deleteObject(s3Key: string): Promise<void> {
    try {
      await this.c.send(new DeleteObjectCommand({ Bucket: this.cfg.s3BucketName, Key: s3Key }));
    } catch (err: unknown) { rethrowMapped(err, this.cfg); }
  }

  /** List all versions of a single S3 object, newest first. */
  async listObjectVersions(s3Key: string): Promise<ObjectVersion[]> {
    try {
      const rsp = await this.c.send(new ListObjectVersionsCommand({
        Bucket: this.cfg.s3BucketName,
        Prefix: s3Key,
      }));
      return (rsp.Versions ?? [])
        .filter((v) => v.Key === s3Key && v.VersionId)
        .map((v) => ({
          versionId: v.VersionId!,
          lastModified: v.LastModified ?? new Date(0),
          size: v.Size ?? 0,
          etag: stripEtagQuotes(v.ETag ?? ""),
          isLatest: v.IsLatest ?? false,
        }))
        .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    } catch (err: unknown) { rethrowMapped(err, this.cfg); }
  }

  async getObjectVersion(s3Key: string, versionId: string): Promise<ArrayBuffer> {
    try {
      const rsp = await this.c.send(new GetObjectCommand({
        Bucket: this.cfg.s3BucketName, Key: s3Key, VersionId: versionId,
      }));
      return streamToArrayBuffer(rsp.Body as ReadableStream | Blob | undefined);
    } catch (err: unknown) { rethrowMapped(err, this.cfg); }
  }

  async testConnection(): Promise<void> {
    try {
      await this.c.send(new ListObjectsV2Command({
        Bucket: this.cfg.s3BucketName, MaxKeys: 1, Prefix: this.prefix || undefined,
      }));
    } catch (err: unknown) { rethrowMapped(err, this.cfg); }
  }

  get authMethod() { return this.cfg.authMethod; }
}
