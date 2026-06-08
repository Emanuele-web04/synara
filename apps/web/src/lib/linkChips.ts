// FILE: linkChips.ts
// Purpose: Single source of truth for turning a bare URL into an inline link
//          chip — GitHub-aware shortening, the icon variant (github vs globe),
//          and opening the URL externally. Shared by the composer Lexical link
//          node and the read-only user-message link chip so both render and
//          behave identically.
// Layer: UI utilities

import { readNativeApi } from "~/nativeApi";

/** Matches http(s) URLs. Parentheses and brackets terminate the match so prose
 *  like `(see https://example.com)` keeps the wrapping punctuation as text. */
export const LINK_TOKEN_SOURCE = String.raw`https?:\/\/[^\s<>()\[\]]+`;

// Trailing sentence punctuation that should not be swallowed into the URL.
const TRAILING_PUNCTUATION_REGEX = /[.,;:!?'"]+$/;

/** Trims trailing sentence punctuation so `https://x.com.` becomes `https://x.com`. */
export function trimTrailingLinkPunctuation(url: string): string {
  return url.replace(TRAILING_PUNCTUATION_REGEX, "");
}

const BARE_LINK_REGEX = new RegExp(`^${LINK_TOKEN_SOURCE}$`);

/**
 * Returns the URL when `text` is exactly one bare http(s) link — ignoring surrounding
 * whitespace and trailing sentence punctuation — otherwise null. Used to chip a pasted URL
 * immediately, the way the read-only message bubble renders it, without waiting for a
 * trailing delimiter the way live typing does.
 */
export function parseBareComposerLink(text: string): string | null {
  const url = trimTrailingLinkPunctuation(text.trim());
  return url.length > 0 && BARE_LINK_REGEX.test(url) ? url : null;
}

export interface LinkChipDescriptor {
  /** Display label: shortened GitHub reference, or the de-schemed URL. */
  label: string;
  /** Whether to show the GitHub mark (true) or the globe icon (false). */
  isGitHub: boolean;
}

function stripGitSuffix(repo: string): string {
  return repo.endsWith(".git") ? repo.slice(0, -4) : repo;
}

// Shortens the common GitHub URL shapes into compact references:
//   pull/issue → owner/repo#155, commit → owner/repo@abc1234,
//   repo root  → owner/repo,      user/org → owner.
// Any other GitHub path returns null so it renders as a plain globe link.
function shortenGitHubLink(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    return null;
  }

  const parts = parsed.pathname.split("/").filter((part) => part.length > 0);
  const owner = parts[0];
  if (!owner) {
    return null;
  }

  const repo = parts[1] ? stripGitSuffix(parts[1]) : undefined;
  if (!repo) {
    // github.com/owner → owner
    return owner;
  }

  const kind = parts[2];
  if (!kind) {
    // github.com/owner/repo → owner/repo
    return `${owner}/${repo}`;
  }

  const ref = parts[3];
  if ((kind === "pull" || kind === "issues") && ref && /^\d+$/.test(ref)) {
    return `${owner}/${repo}#${ref}`;
  }
  if (kind === "commit" && ref && /^[0-9a-f]{7,40}$/i.test(ref)) {
    return `${owner}/${repo}@${ref.slice(0, 7)}`;
  }

  // tree/blob/compare/releases/etc. are not "common forms" — fall back to globe.
  return null;
}

/** De-schemes a URL for a compact non-GitHub label (drops protocol, `www.`,
 *  and any trailing slash). */
function prettifyUrl(url: string): string {
  return url
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "");
}

/** Describes how a URL should render as an inline chip. */
export function describeLinkChip(url: string): LinkChipDescriptor {
  const shortened = shortenGitHubLink(url);
  if (shortened) {
    return { label: shortened, isGitHub: true };
  }
  return { label: prettifyUrl(url), isGitHub: false };
}

/** Opens a URL in the user's external browser, falling back to a new tab. */
export function openExternalLink(url: string): void {
  const api = readNativeApi();
  if (api) {
    void api.shell.openExternal(url).catch(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
