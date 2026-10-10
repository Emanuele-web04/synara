import { resolveWsHttpUrl } from "./wsHttpUrl";

/** Per-favicon-src load outcome, shared module-wide to avoid re-probing within a session. */
export const siteFaviconStatusCache = new Map<string, "ok" | "fail">();

/** In-flight probes keyed by favicon src, so concurrent callers share one Image() load. */
const inFlightFaviconProbes = new Map<string, Promise<"ok" | "fail">>();

// resolved outcomes memoized so later renders settle synchronously; concurrent callers share one Image() load yet EACH receives the result — every awaiting icon element runs its own .then and patches itself instead of one probe patching a possibly-stale element
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
  // WS-derived HTTP helper so desktop/file-origin image tags carry the same legacy token as attachments
  return resolveWsHttpUrl(`/api/site-favicon?${params.toString()}`);
}
