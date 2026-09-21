import { decodeOutboundJson, outboundHttp } from "@synara/shared/outboundHttp";

export interface FetchJsonResult {
  readonly status: number;
  readonly ok: boolean;
  readonly json: unknown;
  readonly headers: Headers;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function fetchJson(input: {
  service: string;
  url: string;
  allowedOrigins: ReadonlyArray<string>;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  /** JSON default, or form-encoded for OAuth endpoints */
  bodyFormat?: "json" | "form";
  timeoutMs?: number;
  allowLoopbackHttp?: boolean;
}): Promise<FetchJsonResult> {
  const encodedBody =
    input.body === undefined
      ? undefined
      : input.bodyFormat === "form"
        ? new URLSearchParams(input.body as Record<string, string>).toString()
        : JSON.stringify(input.body);
  const response = await outboundHttp.request({
    policy: {
      service: input.service,
      allowedOrigins: input.allowedOrigins,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRequestBytes: 64 * 1024,
      maxResponseBytes: 1024 * 1024,
      maxRedirects: 0,
      maxConcurrent: 4,
      maxQueued: 8,
      requirePublicAddress: true,
      ...(input.allowLoopbackHttp === true ? { allowLoopbackHttp: true } : {}),
    },
    url: input.url,
    method: input.method ?? "GET",
    headers: input.headers,
    ...(encodedBody === undefined ? {} : { body: encodedBody }),
  });

  let json: unknown = null;
  try {
    json = decodeOutboundJson(response, { maxDepth: 32, maxNodes: 100_000 });
  } catch {
    json = null;
  }

  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    json,
    headers: response.headers,
  };
}

/** stale access token → needs re-auth */
export function isAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/** throttled — callers should back off rather than blank the panel */
export function isRateLimitStatus(status: number): boolean {
  return status === 429;
}

/** delta-seconds and HTTP-date forms; undefined when absent, malformed, or past */
export function parseRetryAfterMs(headers: Headers, nowMs: number): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (/^\d+$/u.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1000;
    return milliseconds > 0 && Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  // HTTP-dates begin with a weekday name — reject number spellings before Date.parse reinterprets `1.5` or `+10`
  if (/^[+\-.\d]/u.test(trimmed)) {
    return undefined;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - nowMs;
    return delta > 0 ? delta : undefined;
  }
  return undefined;
}
