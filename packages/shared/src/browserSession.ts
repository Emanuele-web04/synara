// `window.open` target names that never imply a managed popup
const RESERVED_FRAME_NAMES = new Set(["", "_blank", "_self", "_parent", "_top"]);
export const BROWSER_BLANK_URL = "about:blank";
export const BROWSER_SEARCH_URL_PREFIX = "https://www.google.com/search?q=";

// fit the canonical 1280x800 automation viewport into the card with CSS scale — page zoom stays 1 so the page doesn't reflow
export const BROWSER_AUTOMATION_VIEWPORT_WIDTH = 1_280;
export const BROWSER_AUTOMATION_VIEWPORT_HEIGHT = 800;
/** matches the environment overlay's `p-3` edge gutter */
export const BROWSER_FLOATING_PANEL_MARGIN_PX = 12;

export interface FloatingBrowserGuestLayout {
  width: number;
  height: number;
  scale: number;
  x: number;
  y: number;
}

export function resolveFloatingBrowserGuestLayout(slot: {
  width: number;
  height: number;
}): FloatingBrowserGuestLayout {
  const width = BROWSER_AUTOMATION_VIEWPORT_WIDTH;
  const height = BROWSER_AUTOMATION_VIEWPORT_HEIGHT;
  const slotWidth = Number.isFinite(slot.width) && slot.width > 0 ? slot.width : 1;
  const slotHeight = Number.isFinite(slot.height) && slot.height > 0 ? slot.height : 1;
  const scale = Math.min(1, slotWidth / width, slotHeight / height);
  return {
    width,
    height,
    scale,
    x: Math.max(0, Math.round((slotWidth - width * scale) / 2)),
    y: Math.max(0, Math.round((slotHeight - height * scale) / 2)),
  };
}

export function normalizeBrowserPageZoomFactor(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
}

// dedicated auth hosts are safe popup signals — multi-purpose hosts like github.com need path checks so _blank links still open as tabs
const OAUTH_HOST_PATTERNS: readonly RegExp[] = [
  /(^|\.)accounts\.google\.com$/i,
  /(^|\.)accounts\.youtube\.com$/i,
  /(^|\.)appleid\.apple\.com$/i,
  /(^|\.)login\.microsoftonline\.com$/i,
  /(^|\.)login\.live\.com$/i,
  /(^|\.)auth0\.com$/i,
  /(^|\.)okta\.com$/i,
];

export function isLikelyOAuthHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  return OAUTH_HOST_PATTERNS.some((pattern) => pattern.test(normalized));
}

function looksLikeUrlInput(value: string): boolean {
  return (
    value.includes(".") ||
    value.startsWith("localhost") ||
    value.startsWith("127.0.0.1") ||
    value.startsWith("0.0.0.0") ||
    value.startsWith("[::1]")
  );
}

export function normalizeBrowserUrlInput(input: string | undefined): string {
  const trimmed = input?.trim() ?? "";
  if (trimmed.length === 0) {
    return BROWSER_BLANK_URL;
  }

  try {
    const withScheme = new URL(trimmed);
    if (withScheme.protocol === "http:" || withScheme.protocol === "https:") {
      return withScheme.toString();
    }
    if (withScheme.protocol === "about:") {
      return withScheme.toString();
    }
    if (withScheme.protocol === "file:") {
      return withScheme.toString();
    }
  } catch {}

  if (trimmed.includes(" ")) {
    return `${BROWSER_SEARCH_URL_PREFIX}${encodeURIComponent(trimmed)}`;
  }

  if (looksLikeUrlInput(trimmed)) {
    const prefersHttp =
      trimmed.startsWith("localhost") ||
      trimmed.startsWith("127.0.0.1") ||
      trimmed.startsWith("0.0.0.0") ||
      trimmed.startsWith("[::1]");
    const scheme = prefersHttp ? "http" : "https";
    try {
      return new URL(`${scheme}://${trimmed}`).toString();
    } catch {
      return `${BROWSER_SEARCH_URL_PREFIX}${encodeURIComponent(trimmed)}`;
    }
  }

  return `${BROWSER_SEARCH_URL_PREFIX}${encodeURIComponent(trimmed)}`;
}

export interface BrowserTabUrlLike {
  readonly url?: string | null;
  readonly lastCommittedUrl?: string | null;
}

export function resolveCopyableBrowserTabUrl(
  tab: BrowserTabUrlLike | null | undefined,
  liveUrl?: string | null,
): string | null {
  const live = liveUrl?.trim() ?? "";
  if (live.length > 0 && live !== BROWSER_BLANK_URL) {
    return live;
  }
  const committed = tab?.lastCommittedUrl?.trim() ?? "";
  if (committed.length > 0 && committed !== BROWSER_BLANK_URL) {
    return committed;
  }
  const current = tab?.url?.trim() ?? "";
  return current.length > 0 && current !== BROWSER_BLANK_URL ? current : null;
}

// blank tabs show empty/about:blank on both manager and chrome — keep the startup-home test in one place
export function isBlankBrowserTabUrl(tab: BrowserTabUrlLike | null | undefined): boolean {
  if (!tab) {
    return true;
  }
  const currentUrl = tab.url?.trim() ?? "";
  const committedUrl = tab.lastCommittedUrl?.trim() ?? "";
  return (
    (currentUrl.length === 0 || currentUrl === BROWSER_BLANK_URL) &&
    (committedUrl.length === 0 || committedUrl === BROWSER_BLANK_URL)
  );
}

export interface BrowserWindowOpenIntent {
  readonly url: string;
  readonly frameName: string;
  readonly features: string;
  readonly disposition: string;
}

export type BrowserWindowOpenKind = "popup" | "tab";

// multi-purpose provider domains only count as OAuth when the path is the auth endpoint
function isLikelyOAuthUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (isLikelyOAuthHost(host)) {
      return true;
    }
    if (host === "github.com") {
      return path === "/login/oauth/authorize";
    }
    if (host === "gitlab.com" || host.endsWith(".gitlab.com")) {
      return path === "/oauth/authorize";
    }
    if (host === "facebook.com" || host.endsWith(".facebook.com")) {
      return path === "/dialog/oauth" || /^\/v\d+\.\d+\/dialog\/oauth$/.test(path);
    }
    if (host === "slack.com" || host.endsWith(".slack.com")) {
      return path === "/oauth/v2/authorize" || path === "/openid/connect/authorize";
    }
    if (host === "discord.com" || host.endsWith(".discord.com")) {
      return path === "/oauth2/authorize" || path === "/api/oauth2/authorize";
    }
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
      return path === "/oauth/v2/authorization";
    }
    return false;
  } catch {
    return false;
  }
}

// popups exist for OAuth handshakes relying on window.opener/postMessage; reserved targets without features stay tabs
export function classifyBrowserWindowOpen(intent: BrowserWindowOpenIntent): BrowserWindowOpenKind {
  if (intent.url.trim().toLowerCase() === BROWSER_BLANK_URL) {
    // OAuth SDKs often open a blank staging window then assign the provider URL — it must stay a real popup so the opener handshake survives
    return "popup";
  }
  // Electron reports scripted `window.open()` as `new-window` — disposition is context, not a popup signal
  if (intent.features.trim().length > 0) {
    return "popup";
  }
  if (!RESERVED_FRAME_NAMES.has(intent.frameName.trim().toLowerCase())) {
    return "popup";
  }
  if (isLikelyOAuthUrl(intent.url)) {
    return "popup";
  }
  return "tab";
}

const ELECTRON_UA_TOKEN_PATTERN = /\sElectron\/\S+/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// strip Electron + host-app tokens so pages see vanilla Chrome — Google rejects the default Electron UA with `disallowed_useragent`, blocking OAuth entirely
export function deriveChromeUserAgent(
  baseUserAgent: string,
  appProductTokens: readonly string[] = [],
): string {
  let userAgent = baseUserAgent.replace(ELECTRON_UA_TOKEN_PATTERN, "");
  for (const token of appProductTokens) {
    const trimmed = token.trim();
    if (trimmed.length === 0) {
      continue;
    }
    userAgent = userAgent.replace(new RegExp(`\\s${escapeRegExp(trimmed)}\\/\\S+`, "gi"), "");
  }
  return userAgent.replace(/\s{2,}/g, " ").trim();
}

export function chromeMajorVersionFromUserAgent(userAgent: string): string | null {
  const match = /Chrome\/(\d+)/i.exec(userAgent);
  return match?.[1] ?? null;
}

// map a Node platform id to the `Sec-CH-UA-Platform` value Chrome reports
export function chromeClientHintPlatform(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    default:
      return "Linux";
  }
}

export interface ChromeClientHintHeaders {
  readonly "sec-ch-ua": string;
  readonly "sec-ch-ua-mobile": string;
  readonly "sec-ch-ua-platform": string;
}

// `setUserAgent` doesn't touch `sec-ch-ua*` hints which still expose Electron — OAuth providers read them, so rewrite or sign-in fails; null when the Chrome version can't be parsed
export function buildChromeClientHints(
  userAgent: string,
  platform: string,
): ChromeClientHintHeaders | null {
  const major = chromeMajorVersionFromUserAgent(userAgent);
  if (major === null) {
    return null;
  }
  return {
    "sec-ch-ua": `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not=A?Brand";v="24"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"${chromeClientHintPlatform(platform)}"`,
  };
}

// build a Chrome-style Accept-Language so embedded pages see a consistent non-Electron locale
export function buildAcceptLanguageHeader(languages: readonly string[]): string | null {
  const normalized = languages
    .map((language) => language.trim())
    .filter((value) => value.length > 0);
  if (normalized.length === 0) {
    return null;
  }
  return normalized
    .map((language, index) => {
      if (index === 0) {
        return language;
      }
      const quality = Math.max(0.1, 1 - index * 0.1);
      return `${language};q=${quality.toFixed(1)}`;
    })
    .join(",");
}
