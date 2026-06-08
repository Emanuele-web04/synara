// FILE: siteFavicon.ts
// Purpose: Client helpers for the website-favicon feature — build authenticated
//          favicon proxy URLs (keyed by hostname so every link on a site shares
//          one cacheable request) and track per-src load outcomes so repeat
//          renders skip re-probing. Shared by <SiteFavicon> and every link chip
//          surface (composer, user bubble, markdown).
// Layer: UI utilities

import { resolveWsHttpUrl } from "./wsHttpUrl";

/** Per-favicon-src load outcome, shared module-wide to avoid re-probing within a session. */
export const siteFaviconStatusCache = new Map<string, "ok" | "fail">();

/** In-flight probes keyed by favicon src, so concurrent callers share one Image() load. */
const inFlightFaviconProbes = new Map<string, Promise<"ok" | "fail">>();

/**
 * Probes a favicon src once and shares the outcome with every caller. Resolved
 * outcomes are memoized in {@link siteFaviconStatusCache} so later renders settle
 * synchronously; concurrent callers await a single shared Image() load yet EACH
 * receives the result. That last part matters for imperative consumers (the
 * composer link chip): every awaiting icon element runs its own `.then` and
 * patches itself, instead of one shared probe patching a single — possibly stale —
 * element.
 */
export function probeSiteFavicon(faviconSrc: string): Promise<"ok" | "fail"> {
  const cached = siteFaviconStatusCache.get(faviconSrc);
  if (cached) return Promise.resolve(cached);

  const pending = inFlightFaviconProbes.get(faviconSrc);
  if (pending) return pending;

  const promise = new Promise<"ok" | "fail">((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => resolve("ok"));
    image.addEventListener("error", () => resolve("fail"));
    image.src = faviconSrc;
  }).then((status) => {
    siteFaviconStatusCache.set(faviconSrc, status);
    inFlightFaviconProbes.delete(faviconSrc);
    return status;
  });

  inFlightFaviconProbes.set(faviconSrc, promise);
  return promise;
}

/** Extracts the hostname from a full URL, or null when it cannot be parsed. */
export function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Builds the server favicon-proxy URL for a site. The `domain` parameter is the
 * hostname (not the full URL) so the browser HTTP cache and the server cache both
 * collapse every link on a site onto a single entry.
 */
export function resolveSiteFaviconUrl(urlOrHost: string): string {
  const host = extractHostname(urlOrHost) ?? urlOrHost;
  const params = new URLSearchParams({ domain: host });
  // Route through the WS-derived HTTP helper so desktop/file-origin image tags
  // carry the same legacy token as attachments and local markdown images.
  return resolveWsHttpUrl(`/api/site-favicon?${params.toString()}`);
}
