import type { ProviderKind, ServerProviderUsageSnapshot } from "@synara/contracts";
import { PROVIDER_DESCRIPTORS, PROVIDER_DESCRIPTOR_BY_KIND } from "./providerMetadata";

/** providers, in display order, that expose a live usage source */
export const PROVIDER_USAGE_PROVIDERS: ReadonlyArray<ProviderKind> = PROVIDER_DESCRIPTORS.flatMap(
  (descriptor) => (descriptor.usage ? [descriptor.kind] : []),
);

// provider ids cross the WebSocket as plain strings — helpers accept any string and resolve against the typed table
function lookupMeta(provider: string | null | undefined) {
  if (!provider) {
    return undefined;
  }
  const descriptor = PROVIDER_DESCRIPTOR_BY_KIND[provider as ProviderKind];
  return descriptor?.usage ? descriptor : undefined;
}

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

export function providerUsageNeedsAuthDetail(provider: string | null | undefined): string {
  const meta = lookupMeta(provider);
  if (!meta) {
    return "Sign in with the provider CLI to see usage.";
  }
  return `Sign in with \`${meta.usage!.signInCommand}\` to see usage.`;
}

/** show every usage-capable provider when none are signed in (so the panel explains how to connect); once any has credentials, only connected snapshots stay visible */
export function selectVisibleProviderUsageSnapshots(
  snapshots: ReadonlyArray<ServerProviderUsageSnapshot>,
): ReadonlyArray<ServerProviderUsageSnapshot> {
  const byProvider = new Map(snapshots.map((snapshot) => [snapshot.provider, snapshot]));
  const ordered = PROVIDER_USAGE_PROVIDERS.flatMap((provider) => {
    const snapshot = byProvider.get(provider);
    return snapshot ? [snapshot] : [];
  });
  const connected = ordered.filter((snapshot) => (snapshot.status ?? "ok") !== "needs-auth");
  return connected.length > 0 ? connected : ordered;
}
