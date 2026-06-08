// FILE: siteFavicon.ts
// Purpose: Client helpers for the website-favicon feature — build authenticated
//          favicon proxy URLs (keyed by hostname so every link on a site shares
//          one cacheable request) and track per-src load outcomes so repeat
//          renders skip re-probing. Shared by the <SiteFavicon> component and
//          the Lexical composer link chip.
// Layer: UI utilities

import { resolveWsHttpUrl } from "./wsHttpUrl";

/** Per-favicon-src load outcome, shared module-wide to avoid re-probing within a session. */
export const siteFaviconStatusCache = new Map<string, "ok" | "fail">();

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
