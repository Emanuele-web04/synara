// Resumable, stall-aware replacement for electron-updater's macOS file download.
//
// Why this exists:
//   On macOS, electron-updater downloads the update .zip through Electron's
//   `net.request` (Chromium's network stack). Its only stall protection is
//   `httpExecutor.addTimeOutHandler`, which does `request.on("socket", s =>
//   s.setTimeout(...))`. But Electron's `ClientRequest` never emits a `socket`
//   event (it emits only abort/close/error/finish/login/redirect/response), so
//   that timeout is dead code: the update download has no idle timeout at all.
//   When the connection to GitHub's release CDN stalls mid-transfer, nothing
//   aborts it; the transfer hangs until the OS socket recovers on its own
//   (TCP retransmission), which can take minutes. electron-updater also never
//   resumes from a byte offset — a retry re-downloads from 0%.
//
// This module installs a `download` implementation onto the updater's existing
// `httpExecutor` that:
//   - enforces a real idle timeout (aborts a connection that goes silent),
//   - resumes from the last received byte via HTTP Range requests,
//   - retries with bounded backoff while making progress,
//   - follows redirects manually so it can strip the GitHub auth token before
//     it ever reaches the cross-origin signed CDN URL,
//   - discards any pre-existing temp bytes up front (so a failed differential
//     download can never poison the full-download fallback),
//   - verifies the sha512 published in latest-mac.yml before completing,
//   - honours the shared CancellationToken exactly like the stock executor.
//
// It reuses the executor's `createRequest` (cached Electron net session + proxy
// login wiring) so everything downstream — cache placement, the Squirrel.Mac
// proxy server, `update-downloaded`, quitAndInstall — is unchanged.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";

export interface ResumableProgressInfo {
  readonly total: number;
  readonly delta: number;
  readonly transferred: number;
  readonly percent: number;
  readonly bytesPerSecond: number;
}

export interface ResumableDownloadConfig {
  // Abort a connection that delivers no bytes for this long, then resume.
  readonly idleTimeoutMs: number;
  // Backoff between reconnect attempts (the first reconnect is immediate).
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  // Give up after this many consecutive attempts that add zero new bytes.
  readonly maxConsecutiveStallRetries: number;
  // Absolute caps so a flapping connection can never loop forever.
  readonly maxTotalAttempts: number;
  readonly overallTimeoutMs: number;
  // Throttle for emitted progress events.
  readonly progressThrottleMs: number;
  // Cap on redirect hops we follow within a single connection attempt.
  readonly maxRedirects: number;
}

export const DEFAULT_RESUMABLE_DOWNLOAD_CONFIG: ResumableDownloadConfig = {
  idleTimeoutMs: 15_000,
  retryBaseDelayMs: 500,
  retryMaxDelayMs: 5_000,
  maxConsecutiveStallRetries: 6,
  maxTotalAttempts: 100,
  overallTimeoutMs: 10 * 60_000,
  progressThrottleMs: 500,
  maxRedirects: 10,
};

export interface ResumableDownloadLogger {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

// Minimal structural views of the electron-updater / Electron objects we touch,
// so this module needs no direct dependency on their concrete classes.
interface CancellationTokenLike {
  readonly cancelled: boolean;
  createPromise<T>(
    callback: (
      resolve: (value: T) => void,
      reject: (error: Error) => void,
      onCancel: (handler: () => void) => void,
    ) => void,
  ): Promise<T>;
}

export interface ResumableDownloadCallOptions {
  readonly headers?: Record<string, string> | null;
  readonly cancellationToken: CancellationTokenLike;
  readonly sha512?: string;
  readonly sha2?: string;
  onProgress?: (info: ResumableProgressInfo) => void;
}

interface ElectronResponseLike {
  readonly statusCode?: number;
  readonly headers: Record<string, string | string[] | undefined>;
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "aborted", listener: () => void): void;
  removeAllListeners(): void;
  pause(): void;
  resume(): void;
}

interface ElectronClientRequestLike {
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "abort", listener: () => void): void;
  on(event: "close", listener: () => void): void;
  on(
    event: "redirect",
    listener: (statusCode: number, method: string, redirectUrl: string) => void,
  ): void;
  end(): void;
  abort(): void;
}

// Structural view of the request/response the executor passes to its timeout
// handler. We wire the idle timer to the events Electron's net.request actually
// emits (response/data/end/error/abort/close) — never the dead `socket` event.
interface IdleTimeoutResponseLike {
  on(event: "data", listener: () => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: () => void): void;
  on(event: "aborted", listener: () => void): void;
}

interface IdleTimeoutRequestLike {
  on(event: "response", listener: (response: IdleTimeoutResponseLike) => void): void;
  on(event: "error", listener: () => void): void;
  on(event: "abort", listener: () => void): void;
  on(event: "close", listener: () => void): void;
  abort(): void;
}

export interface UpdaterHttpExecutorLike {
  download(url: URL, destination: string, options: ResumableDownloadCallOptions): Promise<string>;
  createRequest(
    options: Record<string, unknown>,
    callback: (response: ElectronResponseLike) => void,
  ): ElectronClientRequestLike;
  // electron-updater wires this for the differential-download and metadata
  // request paths. The stock version targets a `socket` event that Electron's
  // net.request never emits, so it is dead. We replace it with a working one.
  addTimeOutHandler?(
    request: IdleTimeoutRequestLike,
    callback: (error: Error) => void,
    timeout: number,
  ): void;
}

// The structural slice of electron-updater's AppUpdater that we mutate. The
// real `httpExecutor` field is runtime-only (absent from the public types), so
// callers pass `autoUpdater` through a cast.
export interface ResumableDownloaderTarget {
  httpExecutor: UpdaterHttpExecutorLike | null;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in resumableUpdateDownload.test.ts)
// ---------------------------------------------------------------------------

export function computeProgressInfo(args: {
  readonly transferred: number;
  readonly total: number;
  readonly delta: number;
  readonly elapsedMs: number;
}): ResumableProgressInfo {
  const elapsedSeconds = args.elapsedMs > 0 ? args.elapsedMs / 1000 : 0.001;
  return {
    total: args.total,
    delta: args.delta,
    transferred: args.transferred,
    percent: args.total > 0 ? (args.transferred / args.total) * 100 : 0,
    bytesPerSecond: Math.round(args.transferred / elapsedSeconds),
  };
}

// Total size from a Content-Range header, e.g. "bytes 200-1000/1001" -> 1001.
export function parseContentRangeTotal(headerValue: string | null | undefined): number | null {
  if (!headerValue) {
    return null;
  }
  const match = headerValue.match(/\/\s*(\d+)\s*$/);
  if (!match) {
    return null;
  }
  const total = Number(match[1]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

// Mirror electron-updater's DigestTransform heuristic so our standalone
// verification interprets the latest-mac.yml checksum in the same encoding.
export function selectSha512Encoding(sha512: string): "hex" | "base64" {
  return sha512.length === 128 &&
    !sha512.includes("+") &&
    !sha512.includes("Z") &&
    !sha512.includes("=")
    ? "hex"
    : "base64";
}

export type DownloadResponseAction =
  // 206 Partial Content: append the body at the current offset.
  | { readonly kind: "append"; readonly total: number | null }
  // 200 OK: body starts at byte 0 (first attempt, or server ignored Range).
  | { readonly kind: "fromStart"; readonly total: number | null }
  // 416: range not satisfiable — we already hold every byte.
  | { readonly kind: "complete" }
  // 429 / 5xx: transient, worth retrying.
  | { readonly kind: "retryable"; readonly statusCode: number }
  // Anything else (e.g. 403/404): not recoverable by retrying.
  | { readonly kind: "fatal"; readonly statusCode: number };

export function classifyDownloadResponse(args: {
  readonly statusCode: number;
  readonly contentRange: string | null;
  readonly contentLength: number | null;
  readonly bytesAlreadyDownloaded: number;
}): DownloadResponseAction {
  const { statusCode, contentRange, contentLength, bytesAlreadyDownloaded } = args;
  if (statusCode === 206) {
    const total =
      parseContentRangeTotal(contentRange) ??
      (contentLength != null ? bytesAlreadyDownloaded + contentLength : null);
    return { kind: "append", total };
  }
  if (statusCode === 200) {
    return { kind: "fromStart", total: contentLength };
  }
  if (statusCode === 416) {
    return { kind: "complete" };
  }
  if (statusCode === 429 || (statusCode >= 500 && statusCode <= 599)) {
    return { kind: "retryable", statusCode };
  }
  return { kind: "fatal", statusCode };
}

export function computeRetryDelayMs(
  consecutiveStallCount: number,
  config: Pick<ResumableDownloadConfig, "retryBaseDelayMs" | "retryMaxDelayMs">,
): number {
  if (consecutiveStallCount <= 1) {
    // First reconnect after fresh progress should be immediate.
    return 0;
  }
  const delay = config.retryBaseDelayMs * 2 ** (consecutiveStallCount - 2);
  return Math.min(delay, config.retryMaxDelayMs);
}

export function shouldGiveUp(args: {
  readonly consecutiveStallCount: number;
  readonly totalAttempts: number;
  readonly elapsedMs: number;
  readonly config: ResumableDownloadConfig;
}): boolean {
  return (
    args.consecutiveStallCount > args.config.maxConsecutiveStallRetries ||
    args.totalAttempts > args.config.maxTotalAttempts ||
    args.elapsedMs > args.config.overallTimeoutMs
  );
}

function effectivePort(url: URL): string {
  if (url.port.length > 0) {
    return url.port;
  }
  if (url.protocol === "https:") {
    return "443";
  }
  if (url.protocol === "http:") {
    return "80";
  }
  return "";
}

// Two URLs are cross-origin if scheme, host, or effective port differ. Used to
// decide when to drop the auth token (GitHub release URL -> signed CDN URL).
export function isCrossOrigin(a: URL, b: URL): boolean {
  return (
    a.protocol !== b.protocol ||
    a.hostname.toLowerCase() !== b.hostname.toLowerCase() ||
    effectivePort(a) !== effectivePort(b)
  );
}

// Build the request headers for one hop. `attachAuth` is false once a redirect
// has taken us cross-origin from the feed, so the GitHub token never reaches the
// signed CDN. Mirrors builder-util-runtime's cross-origin auth stripping.
export function buildDownloadHeaders(args: {
  readonly callHeaders: Record<string, string> | null | undefined;
  readonly startOffset: number;
  readonly attachAuth: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.callHeaders ?? {})) {
    const lower = key.toLowerCase();
    if (!args.attachAuth && (lower === "authorization" || lower === "proxy-authorization")) {
      continue;
    }
    headers[key] = value;
  }
  if (headers["User-Agent"] == null) {
    headers["User-Agent"] = "electron-builder";
  }
  headers["Cache-Control"] = "no-cache";
  if (args.startOffset > 0) {
    headers["Range"] = `bytes=${args.startOffset}-`;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function headerString(value: string | string[] | undefined): string | null {
  if (value == null) {
    return null;
  }
  if (!Array.isArray(value)) {
    return value;
  }
  return value.length === 0 ? null : (value[value.length - 1] ?? null);
}

function parseIntOrNull(value: string | null): number | null {
  if (value == null) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function safeFileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function removeFileIfExists(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Fail closed: resuming stale temp bytes can poison the full-download fallback.
    throw new Error(`Cannot remove stale update temp file before clean download: ${message}`, {
      cause: error,
    });
  }
}

async function verifySha512(path: string, expected: string): Promise<void> {
  const encoding = selectSha512Encoding(expected);
  const actual = await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha512");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest(encoding)));
  });
  if (actual !== expected) {
    throw new Error(`sha512 checksum mismatch (expected ${expected}, got ${actual}).`);
  }
}

function buildRequestOptions(url: URL, headers: Record<string, string>): Record<string, unknown> {
  const options: Record<string, unknown> = {
    protocol: url.protocol,
    hostname: url.hostname,
    path: `${url.pathname}${url.search}`,
    headers,
    // Follow redirects ourselves so we can strip the auth token before the
    // request leaves GitHub's origin for the signed CDN URL.
    redirect: "manual",
  };
  if (url.port) {
    options.port = url.port;
  }
  return options;
}

interface AttemptResult {
  readonly kind: "complete" | "interrupted";
  readonly reason: string;
  readonly totalSize: number | null;
}

interface SingleAttemptArgs {
  readonly url: URL;
  readonly destination: string;
  readonly options: ResumableDownloadCallOptions;
  readonly createRequest: UpdaterHttpExecutorLike["createRequest"];
  readonly config: ResumableDownloadConfig;
  readonly startOffset: number;
  readonly knownTotal: number | null;
  readonly setActiveRequest: (request: ElectronClientRequestLike | null) => void;
  readonly onChunk: (transferred: number, total: number | null, delta: number) => void;
}

// One connection attempt (following redirects manually). Resolves with whether
// the file is complete or was interrupted (idle timeout, dropped connection,
// premature end, transient status). Rejects only on unrecoverable errors (fatal
// status, too many redirects, disk write failure). Always flushes its write
// stream before resolving so the caller can trust the on-disk file size as the
// authoritative resume offset.
function runSingleAttempt(args: SingleAttemptArgs): Promise<AttemptResult> {
  const { url, destination, options, createRequest, config, startOffset, knownTotal } = args;
  return new Promise<AttemptResult>((resolve, reject) => {
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let writeStream: WriteStream | null = null;
    let activeResponse: ElectronResponseLike | null = null;
    let currentRequest: ElectronClientRequestLike | null = null;
    let discoveredTotal: number | null = knownTotal;
    let baseOffset = startOffset;
    let attemptBytes = 0;
    let redirectCount = 0;

    const clearIdle = (): void => {
      if (idleTimer != null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    // Stop the streaming response from re-arming the idle timer or writing after
    // the stream is closed once this attempt has settled.
    const detachResponse = (): void => {
      if (activeResponse != null) {
        try {
          activeResponse.pause();
          activeResponse.removeAllListeners();
        } catch {
          // ignore
        }
        activeResponse = null;
      }
    };

    const abortCurrent = (): void => {
      try {
        currentRequest?.abort();
      } catch {
        // ignore
      }
    };

    const finish = (result: AttemptResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearIdle();
      detachResponse();
      args.setActiveRequest(null);
      if (writeStream != null) {
        // Flush buffered writes before resolving so the file size on disk is
        // exact for the next attempt's resume offset.
        writeStream.end(() => resolve(result));
      } else {
        resolve(result);
      }
    };

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearIdle();
      detachResponse();
      args.setActiveRequest(null);
      if (writeStream != null) {
        writeStream.destroy();
      }
      reject(error);
    };

    const armIdle = (): void => {
      clearIdle();
      idleTimer = setTimeout(() => {
        // No bytes for idleTimeoutMs: abort this connection so we can resume on
        // a fresh one (which usually lands on a healthy CDN edge).
        abortCurrent();
        finish({ kind: "interrupted", reason: "idle-timeout", totalSize: discoveredTotal });
      }, config.idleTimeoutMs);
      idleTimer.unref?.();
    };

    const onResponse = (res: ElectronResponseLike): void => {
      const statusCode = res.statusCode ?? 0;
      const action = classifyDownloadResponse({
        statusCode,
        contentRange: headerString(res.headers["content-range"]),
        contentLength: parseIntOrNull(headerString(res.headers["content-length"])),
        bytesAlreadyDownloaded: startOffset,
      });

      if (action.kind === "fatal") {
        res.on("error", () => {});
        res.pause();
        // Settle before aborting so the abort fallout is ignored by the guard.
        fail(new Error(`Cannot download update: HTTP ${statusCode}.`));
        abortCurrent();
        return;
      }
      if (action.kind === "retryable") {
        res.on("error", () => {});
        res.pause();
        finish({ kind: "interrupted", reason: `http-${statusCode}`, totalSize: discoveredTotal });
        abortCurrent();
        return;
      }
      if (action.kind === "complete") {
        res.on("error", () => {});
        res.pause();
        finish({ kind: "complete", reason: "range-complete", totalSize: discoveredTotal });
        abortCurrent();
        return;
      }

      if (action.total != null) {
        discoveredTotal = action.total;
      }
      // "fromStart" means the body begins at byte 0: either the first attempt,
      // or the server ignored our Range header — truncate and rewrite from 0.
      baseOffset = action.kind === "append" ? startOffset : 0;
      const flags = action.kind === "append" ? "a" : "w";
      writeStream = createWriteStream(destination, { flags });
      writeStream.on("error", (error) =>
        fail(new Error(`Cannot write update file: ${error.message}`)),
      );

      activeResponse = res;
      res.on("error", () =>
        finish({ kind: "interrupted", reason: "response-error", totalSize: discoveredTotal }),
      );
      res.on("aborted", () =>
        finish({ kind: "interrupted", reason: "response-aborted", totalSize: discoveredTotal }),
      );
      res.on("data", (chunk: Buffer) => {
        armIdle();
        attemptBytes += chunk.length;
        const transferred = baseOffset + attemptBytes;
        args.onChunk(transferred, discoveredTotal, chunk.length);
        const canContinue = writeStream!.write(chunk);
        if (!canContinue) {
          res.pause();
          writeStream!.once("drain", () => res.resume());
        }
      });
      res.on("end", () => {
        const transferred = baseOffset + attemptBytes;
        const reachedTotal = discoveredTotal != null && transferred >= discoveredTotal;
        finish({
          kind: reachedTotal ? "complete" : "interrupted",
          reason: reachedTotal ? "end" : "premature-end",
          totalSize: discoveredTotal,
        });
      });
    };

    // Open one hop. On a redirect we strip the auth token if we leave the feed
    // origin, then reconnect to the redirect target carrying the same Range.
    const connect = (targetUrl: URL): void => {
      const headers = buildDownloadHeaders({
        callHeaders: options.headers,
        startOffset,
        attachAuth: !isCrossOrigin(url, targetUrl),
      });
      // Per-hop guard: when we follow a redirect we abort this hop on purpose,
      // and that abort/error must not be reported as a real interruption.
      let superseded = false;
      const request = createRequest(buildRequestOptions(targetUrl, headers), onResponse);
      currentRequest = request;
      args.setActiveRequest(request);
      request.on("redirect", (statusCode, _method, redirectUrl) => {
        if (superseded || settled) {
          return;
        }
        if (redirectCount >= config.maxRedirects) {
          fail(
            new Error(`Too many redirects while downloading update (> ${config.maxRedirects}).`),
          );
          return;
        }
        redirectCount += 1;
        armIdle();
        let nextUrl: URL;
        try {
          nextUrl = new URL(redirectUrl, targetUrl);
        } catch {
          fail(new Error(`Invalid redirect URL while downloading update: ${redirectUrl}`));
          return;
        }
        superseded = true;
        try {
          request.abort();
        } catch {
          // ignore — we are intentionally dropping this hop.
        }
        connect(nextUrl);
      });
      request.on("error", (error) => {
        if (superseded) {
          return;
        }
        finish({
          kind: "interrupted",
          reason: `request-error: ${error.message}`,
          totalSize: discoveredTotal,
        });
      });
      request.on("abort", () => {
        if (superseded) {
          return;
        }
        finish({ kind: "interrupted", reason: "request-abort", totalSize: discoveredTotal });
      });
      request.end();
    };

    armIdle();
    connect(url);
  });
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

interface RunResumableDownloadArgs {
  readonly url: URL;
  readonly destination: string;
  readonly options: ResumableDownloadCallOptions;
  readonly createRequest: UpdaterHttpExecutorLike["createRequest"];
  readonly config: ResumableDownloadConfig;
  readonly logger: ResumableDownloadLogger;
  readonly registerCancel: (handler: () => void) => void;
}

async function runResumableDownload(args: RunResumableDownloadArgs): Promise<void> {
  const { url, destination, options, createRequest, config, logger, registerCancel } = args;

  let activeRequest: ElectronClientRequestLike | null = null;
  let cancelled = false;
  registerCancel(() => {
    cancelled = true;
    try {
      activeRequest?.abort();
    } catch {
      // ignore
    }
  });

  const startedAtMs = Date.now();
  // Discard any pre-existing bytes (e.g. a checksum-bad temp file left behind by
  // a failed differential download that shares this destination). The stock
  // executor always truncates, so we never inherit foreign bytes either.
  await removeFileIfExists(destination);

  let totalSize: number | null = null;
  let verifyRetryUsed = false;

  // Outer loop runs at most twice: once normally, then once more if the final
  // sha512/size check fails (a one-shot clean re-download from byte 0).
  for (;;) {
    if (cancelled || options.cancellationToken.cancelled) {
      return;
    }

    let downloaded = await safeFileSize(destination);
    let consecutiveStall = 0;
    let attempts = 0;

    let lastEmitMs = 0;
    let deltaAccum = 0;
    const emit = (transferred: number, total: number | null, force: boolean): void => {
      if (options.onProgress == null || total == null) {
        return;
      }
      const now = Date.now();
      if (!force && now - lastEmitMs < config.progressThrottleMs) {
        return;
      }
      options.onProgress(
        computeProgressInfo({
          transferred,
          total,
          delta: deltaAccum,
          elapsedMs: now - startedAtMs,
        }),
      );
      lastEmitMs = now;
      deltaAccum = 0;
    };

    for (;;) {
      if (cancelled || options.cancellationToken.cancelled) {
        // createPromise() rejects with the real CancellationError; just unwind.
        return;
      }
      attempts += 1;
      const startOffset = downloaded;
      const outcome = await runSingleAttempt({
        url,
        destination,
        options,
        createRequest,
        config,
        startOffset,
        knownTotal: totalSize,
        setActiveRequest: (request) => {
          activeRequest = request;
        },
        onChunk: (transferred, total, delta) => {
          if (total != null) {
            totalSize = total;
          }
          deltaAccum += delta;
          emit(transferred, total ?? totalSize, false);
        },
      });

      // The attempt flushed its stream; the file size is the authoritative offset.
      downloaded = await safeFileSize(destination);
      if (outcome.totalSize != null) {
        totalSize = outcome.totalSize;
      }

      if (outcome.kind === "complete") {
        break;
      }

      consecutiveStall = downloaded > startOffset ? 0 : consecutiveStall + 1;
      const elapsedMs = Date.now() - startedAtMs;
      if (
        shouldGiveUp({
          consecutiveStallCount: consecutiveStall,
          totalAttempts: attempts,
          elapsedMs,
          config,
        })
      ) {
        throw new Error(
          `Update download stalled and could not resume (${outcome.reason}; ` +
            `${downloaded}/${totalSize ?? "?"} bytes after ${attempts} attempts).`,
        );
      }
      logger.warn?.(
        `[desktop-updater] Update download interrupted at ${downloaded}/${totalSize ?? "?"} bytes ` +
          `(${outcome.reason}); resuming (attempt ${attempts + 1}).`,
      );
      await delay(computeRetryDelayMs(consecutiveStall, config));
    }

    const verifyError = await verifyDownloadedFile({
      destination,
      downloaded,
      totalSize,
      sha512: options.sha512,
    });
    if (verifyError == null) {
      if (totalSize != null) {
        emit(totalSize, totalSize, true);
      }
      logger.info?.(
        `[desktop-updater] Update download completed (${downloaded} bytes, ${attempts} attempt(s)).`,
      );
      return;
    }

    // The bytes we have are bad. Re-download cleanly from zero exactly once
    // before giving up, in case a CDN edge served corrupt bytes.
    if (verifyRetryUsed) {
      throw verifyError;
    }
    verifyRetryUsed = true;
    totalSize = null;
    logger.warn?.(
      `[desktop-updater] Update verification failed (${verifyError.message}); ` +
        `discarding and re-downloading from zero once.`,
    );
    await removeFileIfExists(destination);
  }
}

async function verifyDownloadedFile(args: {
  readonly destination: string;
  readonly downloaded: number;
  readonly totalSize: number | null;
  readonly sha512?: string | undefined;
}): Promise<Error | null> {
  if (args.totalSize != null && args.downloaded !== args.totalSize) {
    return new Error(
      `Update download size mismatch (${args.downloaded} != ${args.totalSize} bytes).`,
    );
  }
  if (args.sha512 != null && args.sha512.length > 0) {
    try {
      await verifySha512(args.destination, args.sha512);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }
  return null;
}

// A working idle (inactivity) timeout for the executor's request-based paths
// (differential block fetches, blockmap and update metadata). It aborts a
// request that delivers no bytes for `timeoutMs`, wiring to events Electron's
// net.request actually emits instead of the dead `socket` event. On a stalled
// differential fetch this makes electron-updater fall back to the resumable
// full download (see MacUpdater.doDownloadUpdate) instead of hanging.
export function installIdleTimeout(
  request: IdleTimeoutRequestLike,
  onTimeout: (error: Error) => void,
  timeoutMs: number,
): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const arm = (): void => {
    clear();
    timer = setTimeout(() => {
      timer = null;
      try {
        request.abort();
      } catch {
        // ignore
      }
      onTimeout(new Error(`Request timed out after ${timeoutMs}ms of inactivity.`));
    }, timeoutMs);
    timer.unref?.();
  };
  request.on("response", (response) => {
    arm();
    response.on("data", arm);
    response.on("end", clear);
    response.on("error", clear);
    response.on("aborted", clear);
  });
  request.on("error", clear);
  request.on("abort", clear);
  request.on("close", clear);
  // Arm immediately so the connect / waiting-for-headers phase is covered too.
  arm();
}

// Replaces `updater.httpExecutor.download` with the resumable implementation and
// installs a working idle timeout on the executor's request-based paths.
// Returns false if the executor is not yet available. Safe to call once during
// updater configuration.
export function installResumableUpdateDownloader(
  updater: ResumableDownloaderTarget,
  overrides: Partial<ResumableDownloadConfig> = {},
  logger: ResumableDownloadLogger = console,
): boolean {
  const executor = updater.httpExecutor;
  if (executor == null) {
    return false;
  }
  const config: ResumableDownloadConfig = { ...DEFAULT_RESUMABLE_DOWNLOAD_CONFIG, ...overrides };
  const createRequest = executor.createRequest.bind(executor);
  executor.download = (url, destination, options) =>
    options.cancellationToken.createPromise<string>((resolve, reject, onCancel) => {
      runResumableDownload({
        url,
        destination,
        options,
        createRequest,
        config,
        logger,
        registerCancel: onCancel,
      }).then(() => resolve(destination), reject);
    });
  // Patch the dead `socket`-event timeout used by the differential and metadata
  // request paths. `addErrorAndTimeoutHandlers` calls `this.addTimeOutHandler`,
  // so this instance override is picked up there too. Never wait longer than our
  // idle budget, but honour a shorter explicit timeout if one is ever passed.
  executor.addTimeOutHandler = (request, callback, timeout) => {
    const idleMs = timeout > 0 ? Math.min(timeout, config.idleTimeoutMs) : config.idleTimeoutMs;
    installIdleTimeout(request, callback, idleMs);
  };
  return true;
}
