import { outboundHttp } from "@synara/shared/outboundHttp";

const FAVICON_CACHE_MAX = 500;
const FAVICON_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const FAVICON_FAILURE_TTL_MS = 60 * 60 * 1000;
const REMOTE_FETCH_TIMEOUT_MS = 5_000;
const DIRECT_FETCH_TIMEOUT_MS = 3_000;
const MAX_FAVICON_BYTES = 512 * 1024; // cap rogue responses — favicons are tiny

export interface CachedFavicon {
  readonly bytes: Uint8Array | null;
  readonly contentType: string | null;
  readonly expiresAtMs: number;
}

const cache = new Map<string, CachedFavicon>();
const inFlight = new Map<string, Promise<CachedFavicon>>();

/** lower-case the host and drop a leading www. so both share one cache slot */
export function normalizeFaviconHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}

export function tryParseHost(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    const host = normalizeFaviconHost(url.hostname);
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/** SSRF guard for the last-resort https://{host}/favicon.ico source — the Google/DDG sources target fixed third-party hosts and never reach this check */
function isPublicHttpHost(host: string): boolean {
  if (host.length === 0) return false;
  if (host.includes(":") || host.includes("[")) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (!host.includes(".")) return false;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  return true;
}

async function fetchImage(
  url: string,
  timeoutMs: number,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  try {
    const response = await outboundHttp.request({
      policy: {
        service: "site-favicon",
        allowedOrigins: [new URL(url).origin],
        timeoutMs,
        maxRequestBytes: 0,
        maxResponseBytes: MAX_FAVICON_BYTES,
        maxRedirects: 2,
        maxConcurrent: 6,
        maxQueued: 24,
        requirePublicAddress: true,
      },
      url,
      headers: { Accept: "image/*" },
    });
    if (response.status < 200 || response.status >= 300) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) return null;
    if (response.body.byteLength === 0) return null;
    return { bytes: response.body, contentType };
  } catch {
    return null;
  }
}

async function fetchFaviconForHost(
  host: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  // Google S2 — best coverage, clean PNG (generic globe for unknown sites)
  const google = await fetchImage(
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`,
    REMOTE_FETCH_TIMEOUT_MS,
  );
  if (google) return google;

  // DuckDuckGo — no API key, good coverage
  const duckDuckGo = await fetchImage(
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`,
    REMOTE_FETCH_TIMEOUT_MS,
  );
  if (duckDuckGo) return duckDuckGo;

  // direct /favicon.ico — last resort, only publicly routable hosts
  if (isPublicHttpHost(host)) {
    const direct = await fetchImage(`https://${host}/favicon.ico`, DIRECT_FETCH_TIMEOUT_MS);
    if (direct) return direct;
  }

  return null;
}

function storeEntry(host: string, entry: CachedFavicon): void {
  cache.set(host, entry);
  // evict oldest-inserted once over capacity (matches workspaceEntries.ts)
  while (cache.size > FAVICON_CACHE_MAX) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey === undefined || oldestKey === host) break;
    cache.delete(oldestKey);
  }
}

/** TTL cache of resolved bytes plus an in-flight map collapsing concurrent same-host requests into one outbound lookup */
export async function resolveFavicon(host: string): Promise<CachedFavicon> {
  const now = Date.now();
  const cached = cache.get(host);
  if (cached && cached.expiresAtMs > now) return cached;

  const pending = inFlight.get(host);
  if (pending) return pending;

  const promise = (async (): Promise<CachedFavicon> => {
    const result = await fetchFaviconForHost(host);
    const entry: CachedFavicon = result
      ? {
          bytes: result.bytes,
          contentType: result.contentType,
          expiresAtMs: Date.now() + FAVICON_SUCCESS_TTL_MS,
        }
      : { bytes: null, contentType: null, expiresAtMs: Date.now() + FAVICON_FAILURE_TTL_MS };
    storeEntry(host, entry);
    return entry;
  })().finally(() => {
    inFlight.delete(host);
  });

  inFlight.set(host, promise);
  return promise;
}

export function clearSiteFaviconCache(): void {
  cache.clear();
  inFlight.clear();
}
