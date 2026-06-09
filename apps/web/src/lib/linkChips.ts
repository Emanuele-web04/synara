// FILE: linkChips.ts
// Purpose: Single source of truth for turning URLs/domains into inline link
//          chips — normalizing bare domains, GitHub-aware shortening, the icon
//          variant (github vs favicon), and opening links externally. Shared by
//          the composer Lexical link node and read-only message chips.
// Layer: UI utilities

import { readNativeApi } from "~/nativeApi";

const LINK_BODY_SOURCE = String.raw`[^\s<>()\[\]]+`;
const BARE_DOMAIN_SOURCE = String.raw`(?<![A-Za-z0-9@._/-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(?::\d{2,5})?(?:[/?#][^\s<>()\[\]]*)?`;
const HTTP_URL_PATTERN = /^https?:\/\//i;
const COMMON_PUBLIC_BARE_DOMAIN_TLDS = new Set([
  "ai",
  "app",
  "co",
  "com",
  "dev",
  "io",
  "net",
  "org",
]);
const COMMON_FILE_EXTENSION_TLDS = new Set([
  "c",
  "cc",
  "conf",
  "cpp",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "lock",
  "md",
  "mjs",
  "py",
  "rb",
  "rs",
  "sql",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

/** Matches http(s) URLs and public-looking bare domains. Parentheses and brackets
 *  terminate the match so prose like `(see example.com)` keeps wrappers as text. */
export const LINK_TOKEN_SOURCE = String.raw`(?:https?:\/\/${LINK_BODY_SOURCE}|${BARE_DOMAIN_SOURCE})`;

// Trailing sentence punctuation that should not be swallowed into the URL.
const TRAILING_PUNCTUATION_REGEX = /[.,;:!?'"]+$/;

/** Trims trailing sentence punctuation so `https://x.com.` becomes `https://x.com`. */
export function trimTrailingLinkPunctuation(url: string): string {
  return url.replace(TRAILING_PUNCTUATION_REGEX, "");
}

const BARE_LINK_REGEX = new RegExp(`^${LINK_TOKEN_SOURCE}$`);

function parseUrlForLinkChip(url: string): URL | null {
  try {
    return new URL(HTTP_URL_PATTERN.test(url) ? url : `https://${url}`);
  } catch {
    return null;
  }
}

function isLikelyBareDomainLink(url: string): boolean {
  const parsed = parseUrlForLinkChip(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  if (!host.includes(".")) return false;

  const labels = host.split(".");
  const tld = labels.at(-1) ?? "";
  if (!/^[a-z]{2,63}$/.test(tld)) return false;
  if (labels.some((label) => label.length === 0 || label.startsWith("-") || label.endsWith("-"))) {
    return false;
  }

  const hasPathOrQuery = /[/?#]/.test(url);
  if (!hasPathOrQuery && COMMON_FILE_EXTENSION_TLDS.has(tld)) {
    return false;
  }
  if (!hasPathOrQuery && !host.startsWith("www.") && !COMMON_PUBLIC_BARE_DOMAIN_TLDS.has(tld)) {
    return false;
  }
  return true;
}

/** Normalizes a matched link token to a browser-openable URL. Bare domains get https://. */
export function normalizeComposerLinkUrl(rawUrl: string): string | null {
  const url = trimTrailingLinkPunctuation(rawUrl.trim());
  if (url.length === 0) return null;
  if (HTTP_URL_PATTERN.test(url)) return url;
  return isLikelyBareDomainLink(url) ? `https://${url}` : null;
}

/**
 * Returns the normalized URL when `text` is exactly one link/domain — ignoring surrounding
 * whitespace and trailing sentence punctuation — otherwise null. Used to chip a pasted URL
 * immediately, the way the read-only message bubble renders it, without waiting for a
 * trailing delimiter the way live typing does.
 */
export function parseBareComposerLink(text: string): string | null {
  const candidate = trimTrailingLinkPunctuation(text.trim());
  return candidate.length > 0 && BARE_LINK_REGEX.test(candidate)
    ? normalizeComposerLinkUrl(candidate)
    : null;
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
  const parsed = parseUrlForLinkChip(url);
  if (!parsed) return null;

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
  const href = normalizeComposerLinkUrl(url) ?? url;
  const api = readNativeApi();
  if (api) {
    void api.shell.openExternal(href).catch(() => {
      window.open(href, "_blank", "noopener,noreferrer");
    });
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}
