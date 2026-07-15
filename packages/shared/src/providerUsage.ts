// FILE: providerUsage.ts
// Purpose: Single source of truth for provider-usage presentation metadata shared by
// the server (live usage fetchers) and the web app (Settings → Usage, toolbar popover):
// which providers expose a usage source, their display labels, learn-more URLs, and the
// read-only "sign in via CLI" hint used when a credential is missing or expired.
// Layer: cross-cutting (no runtime deps beyond the ProviderKind type).

import type { ProviderKind } from "@synara/contracts";

interface ProviderUsageMeta {
  /** Short human label, e.g. "Claude". */
  displayName: string;
  /** CLI command that re-authenticates the provider, e.g. "codex login". */
  signInCommand: string;
  /** External docs/dashboard URL for "Learn more", or null when none fits. */
  learnMoreHref: string | null;
}

// Only providers with a real, fetchable usage source live here. grok/kilo/pi/opencode are
// intentionally absent — they have no usage endpoint we can read (see SYN-74).
const PROVIDER_USAGE_META: Partial<Record<ProviderKind, ProviderUsageMeta>> = {
  codex: {
    displayName: "Codex",
    signInCommand: "codex login",
    learnMoreHref: "https://platform.openai.com/usage",
  },
  claudeAgent: {
    displayName: "Claude",
    signInCommand: "claude",
    learnMoreHref: "https://docs.anthropic.com/en/docs/about-claude/models#rate-limits",
  },
  cursor: {
    displayName: "Cursor",
    signInCommand: "cursor-agent login",
    learnMoreHref: "https://cursor.com/dashboard",
  },
  gemini: {
    displayName: "Gemini",
    signInCommand: "gemini",
    learnMoreHref: "https://ai.google.dev/gemini-api/docs/quota",
  },
};

/** Providers, in display order, that expose a live usage source. */
export const PROVIDER_USAGE_PROVIDERS: ReadonlyArray<ProviderKind> = [
  "codex",
  "claudeAgent",
  "cursor",
  "gemini",
];

// Provider ids cross the WebSocket as plain strings (rate-limit event payloads), so the
// lookup helpers accept any string and resolve against the typed metadata table at runtime.
function lookupMeta(provider: string | null | undefined): ProviderUsageMeta | undefined {
  if (!provider) {
    return undefined;
  }
  return PROVIDER_USAGE_META[provider as ProviderKind];
}

export function isProviderUsageSupported(provider: string | null | undefined): boolean {
  return lookupMeta(provider) !== undefined;
}

/** Panel title like "Codex usage"; falls back to a generic label for unknown providers. */
export function providerUsageLabel(provider: string | null | undefined): string {
  const meta = lookupMeta(provider);
  return meta ? `${meta.displayName} usage` : "Usage";
}

export function providerUsageDisplayName(provider: string | null | undefined): string {
  return lookupMeta(provider)?.displayName ?? "Provider";
}

export function providerUsageLearnMoreHref(provider: string | null | undefined): string | null {
  return lookupMeta(provider)?.learnMoreHref ?? null;
}

/** Detail sentence shown when usage can't be read because the credential is missing/expired. */
export function providerUsageNeedsAuthDetail(provider: string | null | undefined): string {
  const meta = lookupMeta(provider);
  if (!meta) {
    return "Sign in with the provider CLI to see usage.";
  }
  return `Sign in with \`${meta.signInCommand}\` to see usage.`;
}
