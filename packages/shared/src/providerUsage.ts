// FILE: providerUsage.ts
// Purpose: Single source of truth for provider-usage presentation metadata shared by
// the server (live usage fetchers) and the web app (Settings → Usage, toolbar popover):
// which providers expose a usage source, their display labels, learn-more URLs, and the
// read-only "sign in via CLI" hint used when a credential is missing or expired.
// Layer: cross-cutting (no runtime deps beyond the ProviderKind type).

import type { ProviderKind } from "@synara/contracts";
import { PROVIDER_DESCRIPTORS, PROVIDER_DESCRIPTOR_BY_KIND } from "./providerMetadata";

/** Providers, in display order, that expose a live usage source. */
export const PROVIDER_USAGE_PROVIDERS: ReadonlyArray<ProviderKind> = PROVIDER_DESCRIPTORS.flatMap(
  (descriptor) => (descriptor.usage ? [descriptor.kind] : []),
);

// Provider ids cross the WebSocket as plain strings (rate-limit event payloads), so the
// lookup helpers accept any string and resolve against the typed metadata table at runtime.
function lookupMeta(provider: string | null | undefined) {
  if (!provider) {
    return undefined;
  }
  const descriptor = PROVIDER_DESCRIPTOR_BY_KIND[provider as ProviderKind];
  return descriptor?.usage ? descriptor : undefined;
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
  return lookupMeta(provider)?.usage?.learnMoreHref ?? null;
}

/** Detail sentence shown when usage can't be read because the credential is missing/expired. */
export function providerUsageNeedsAuthDetail(provider: string | null | undefined): string {
  const meta = lookupMeta(provider);
  if (!meta) {
    return "Sign in with the provider CLI to see usage.";
  }
  return `Sign in with \`${meta.usage!.signInCommand}\` to see usage.`;
}
