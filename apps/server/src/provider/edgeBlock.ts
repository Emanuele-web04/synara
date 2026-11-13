// Provider API hosts sit behind Cloudflare, which can refuse a healthy request with an
// HTML 403 page ("Attention Required! | Cloudflare", "Just a moment..."). CLIs surface
// only text, so the page's markers are the evidence the login itself is fine.
const CLOUDFLARE_PAGE_PATTERN = /cloudflare|attention required|just a moment/i;
const HTTP_403_PATTERN = /\b403\b/;

export const PROVIDER_EDGE_BLOCKED_ERROR_CODE = "edge_blocked";

export function isProviderEdgeBlockedText(text: string): boolean {
  return HTTP_403_PATTERN.test(text) && CLOUDFLARE_PAGE_PATTERN.test(text);
}
