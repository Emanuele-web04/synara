// FILE: providerDiscoveryInvalidation.ts
// Purpose: Keeps provider-discovery cache invalidation tied to meaningful provider changes.
// Layer: Web UI provider discovery
// Exports: providerModelDiscoveryInvalidationFingerprint

import type { ServerProviderStatus } from "@synara/contracts";

type ProviderModelDiscoveryFingerprintEntry = readonly [
  provider: ServerProviderStatus["provider"],
  instanceId: string | null,
  driver: string | null,
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
        provider.instanceId ?? null,
        provider.driver ?? null,
        provider.status,
        provider.available,
        provider.authStatus,
        provider.authType ?? null,
        provider.authLabel ?? null,
        provider.version ?? null,
      ],
    )
    .toSorted((left, right) => {
      const providerOrder = left[0].localeCompare(right[0]);
      if (providerOrder !== 0) {
        return providerOrder;
      }
      return (left[1] ?? "").localeCompare(right[1] ?? "");
    });

  return JSON.stringify(entries);
}
