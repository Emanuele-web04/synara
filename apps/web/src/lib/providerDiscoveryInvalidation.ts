// FILE: providerDiscoveryInvalidation.ts
// Purpose: Keeps provider-discovery cache invalidation tied to meaningful provider changes.
// Layer: Web UI provider discovery
// Exports: providerModelDiscoveryInvalidationFingerprint

import type { ServerProviderStatus } from "@synara/contracts";

type ProviderModelDiscoveryFingerprintEntry = readonly [
  provider: ServerProviderStatus["provider"],
  status: ServerProviderStatus["status"],
  available: boolean,
  authStatus: ServerProviderStatus["authStatus"],
  authType: string | null,
  authLabel: string | null,
  version: string | null,
];

export function providerModelDiscoveryInvalidationFingerprint(
  providers: ReadonlyArray<ServerProviderStatus>,
): string {
  const entries = providers
    .map(
      (provider): ProviderModelDiscoveryFingerprintEntry => [
        provider.provider,
        provider.status,
        provider.available,
        provider.authStatus,
        provider.authType ?? null,
        provider.authLabel ?? null,
        provider.version ?? null,
      ],
    )
    .toSorted((left, right) => left[0].localeCompare(right[0]));

  return JSON.stringify(entries);
}
