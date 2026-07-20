// FILE: resumableUpdateDownloadPolicy.ts
// Purpose: Defines the synchronous HTTP, retry, progress, and checksum policy for resumable updates.
// Layer: Desktop updater policy
// Depends on: URL and plain data only; no filesystem, socket, Electron, or updater lifecycle.

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
