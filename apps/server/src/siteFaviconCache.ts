// FILE: siteFaviconCache.ts
// Purpose: Resolve and cache website favicons by domain so the UI can render a
//          real site icon (instead of a generic globe) for link chips and
//          markdown source links. Deduplicates by hostname — every URL on a
//          given site shares one outbound fetch and one cached blob.
// Layer: Server runtime utility (plain module; called from the HTTP route via
//          Effect.promise). Follows the Map + TTL + max-size eviction pattern
//          used by providerUsageSnapshot.ts / workspaceEntries.ts.

import { outboundHttp } from "@synara/shared/outboundHttp";

const FAVICON_CACHE_MAX = 500;
const FAVICON_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const FAVICON_FAILURE_TTL_MS = 60 * 60 * 1000; // 1 h (negative cache)
const REMOTE_FETCH_TIMEOUT_MS = 5_000;
const DIRECT_FETCH_TIMEOUT_MS = 3_000;
const MAX_FAVICON_BYTES = 512 * 1024; // 512 KB — favicons are tiny; cap rogue responses.

export interface CachedFavicon {
  /** Resolved image bytes, or null when every source failed (serve the SVG fallback). */
  readonly bytes: Uint8Array | null;
  readonly contentType: string | null;
  readonly expiresAtMs: number;
}

const cache = new Map<string, CachedFavicon>();
const inFlight = new Map<string, Promise<CachedFavicon>>();

/** Lower-cases the host and drops a leading `www.` so `www.x.com` and `x.com` share a cache slot. */
export function normalizeFaviconHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}

/**
 * Extracts a normalized hostname from a full URL or a bare domain.
 * Returns null when the input cannot be parsed into a host.
 */
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

/**
 * Whether a host is safe to fetch directly (SSRF guard for the last-resort
 * `https://{host}/favicon.ico` source). The Google/DuckDuckGo sources target
 * fixed third-party hosts and never reach this check.
 */
function isPublicHttpHost(host: string): boolean {
  if (host.length === 0) return false;
  if (host.includes(":") || host.includes("[")) return false; // IPv6 / stray port
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (!host.includes(".")) return false; // single-label hosts aren't publicly routable

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0 || a === 10 || a === 127) return false; // this-network / private / loopback
    if (a === 169 && b === 254) return false; // link-local (incl. cloud metadata 169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 192 && b === 168) return false; // private
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
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
  // 1) Google S2 — best coverage, returns a clean PNG (a generic globe for unknown sites).
  const google = await fetchImage(
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`,
    REMOTE_FETCH_TIMEOUT_MS,
  );
  if (google) return google;

  // 2) DuckDuckGo — no API key, good coverage.
  const duckDuckGo = await fetchImage(
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`,
    REMOTE_FETCH_TIMEOUT_MS,
  );
  if (duckDuckGo) return duckDuckGo;

  // 3) Direct /favicon.ico — last resort, only for publicly routable hosts.
  if (isPublicHttpHost(host)) {
    const direct = await fetchImage(`https://${host}/favicon.ico`, DIRECT_FETCH_TIMEOUT_MS);
    if (direct) return direct;
  }

  return null;
}

function storeEntry(host: string, entry: CachedFavicon): void {
  cache.set(host, entry);
  // Evict oldest-inserted entries once over capacity (matches workspaceEntries.ts).
  while (cache.size > FAVICON_CACHE_MAX) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey === undefined || oldestKey === host) break;
    cache.delete(oldestKey);
  }
}

/**
 * Resolves the favicon for a normalized host, using a two-layer guard:
 * a TTL cache of resolved bytes and an in-flight map that collapses concurrent
 * requests for the same host into a single outbound lookup.
 */
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

/** Test/maintenance helper: clears all cached and in-flight favicon state. */
export function clearSiteFaviconCache(): void {
  cache.clear();
  inFlight.clear();
}
