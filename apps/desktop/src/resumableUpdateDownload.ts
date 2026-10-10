// stall-aware resumable replacement for electron-updater's macOS download: its idle timeout listens for a `socket` event Electron's net.request never emits (dead code), and retries restart from 0% — this wires a real idle timeout to events net.request actually emits, resumes via Range requests, strips the GitHub token before the cross-origin CDN hop, verifies the published sha512, and reuses the executor's createRequest so proxy/cache/Squirrel stay unchanged

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";

import {
  buildDownloadHeaders,
  classifyDownloadResponse,
  computeProgressInfo,
  computeRetryDelayMs,
  DEFAULT_RESUMABLE_DOWNLOAD_CONFIG,
  isCrossOrigin,
  selectSha512Encoding,
  shouldGiveUp,
  type ResumableDownloadConfig,
  type ResumableProgressInfo,
} from "./resumableUpdateDownloadPolicy";

export {
  buildDownloadHeaders,
  classifyDownloadResponse,
  computeProgressInfo,
  computeRetryDelayMs,
  DEFAULT_RESUMABLE_DOWNLOAD_CONFIG,
  isCrossOrigin,
  parseContentRangeTotal,
  selectSha512Encoding,
  shouldGiveUp,
  type DownloadResponseAction,
  type ResumableDownloadConfig,
  type ResumableProgressInfo,
} from "./resumableUpdateDownloadPolicy";

export interface ResumableDownloadLogger {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

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

// the idle timer wires to events Electron's net.request actually emits — never the dead `socket` event the stock handler targets
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
  addTimeOutHandler?(
    request: IdleTimeoutRequestLike,
    callback: (error: Error) => void,
    timeout: number,
  ): void;
}

// httpExecutor is a runtime-only field absent from the public types — callers pass autoUpdater through a cast
export interface ResumableDownloaderTarget {
  httpExecutor: UpdaterHttpExecutorLike | null;
}

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
    // follow redirects ourselves so the auth token is stripped before the request leaves GitHub's origin for the signed CDN URL
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

// one connection attempt: resolves complete-or-interrupted, rejects only unrecoverable errors; always flushes the write stream first so on-disk size is the authoritative resume offset
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

    // Stop the streaming response from re-arming the idle timer or writing after the stream is closed once this attempt has settled.
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
        // flush buffered writes before resolving so the file size is exact for the next attempt's resume offset
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
        // no bytes for idleTimeoutMs → abort and resume on a fresh connection, which usually lands on a healthy CDN edge
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
      // "fromStart" means byte 0 — first attempt or the server ignored Range → truncate and rewrite
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

    // one hop: on redirect strip the auth token if leaving the feed origin, then reconnect carrying the same Range
    const connect = (targetUrl: URL): void => {
      const headers = buildDownloadHeaders({
        callHeaders: options.headers,
        startOffset,
        attachAuth: !isCrossOrigin(url, targetUrl),
      });
      // a redirect-follow aborts this hop on purpose — that abort/error must not be reported as a real interruption
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
  // discard pre-existing bytes (e.g. a checksum-bad temp left by a failed differential download sharing this destination) — the stock executor always truncates too
  await removeFileIfExists(destination);

  let totalSize: number | null = null;
  let verifyRetryUsed = false;

  // Outer loop runs at most twice: once normally, then once more if the final sha512/size check fails (a one-shot clean re-download from byte 0).
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

    // bad bytes: one clean re-download from zero before giving up, in case a CDN edge served corrupt bytes
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

// working idle timeout for the executor's request-based paths (differential fetches, blockmap, metadata) — on a stalled differential electron-updater falls back to the resumable full download instead of hanging
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
  // patch the dead `socket`-event timeout via an instance override that addErrorAndTimeoutHandlers picks up; never wait longer than our idle budget but honor a shorter explicit timeout
  executor.addTimeOutHandler = (request, callback, timeout) => {
    const idleMs = timeout > 0 ? Math.min(timeout, config.idleTimeoutMs) : config.idleTimeoutMs;
    installIdleTimeout(request, callback, idleMs);
  };
  return true;
}
