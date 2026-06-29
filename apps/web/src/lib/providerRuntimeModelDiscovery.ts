/**
 * Shared runtime model-discovery flags for providers that fetch models from a live CLI session.
 *
 * @module providerRuntimeModelDiscovery
 */
import type { ProviderKind } from "@t3tools/contracts";

export const PROVIDERS_REQUIRING_RUNTIME_MODEL_DISCOVERY = new Set<ProviderKind>([
  "cursor",
  "devin",
  "kilo",
  "opencode",
  "pi",
]);

export interface ProviderModelsQueryState {
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly data: unknown;
}

export function providerRequiresRuntimeModelDiscovery(provider: ProviderKind): boolean {
  return PROVIDERS_REQUIRING_RUNTIME_MODEL_DISCOVERY.has(provider);
}

export function resolveProviderRuntimeModelDiscoveryPending(
  provider: ProviderKind,
  pendingByProvider: Readonly<Partial<Record<ProviderKind, boolean>>>,
  modelsQuery?: ProviderModelsQueryState,
): boolean {
  const explicitPending = pendingByProvider[provider];
  if (explicitPending !== undefined) {
    return explicitPending;
  }
  if (!modelsQuery) {
    return false;
  }
  return modelsQuery.isLoading || (modelsQuery.isFetching && modelsQuery.data === undefined);
}

export function resolveProviderModelsLoading(
  provider: ProviderKind,
  pendingByProvider: Readonly<Partial<Record<ProviderKind, boolean>>>,
  modelsQuery?: ProviderModelsQueryState,
): boolean {
  if (providerRequiresRuntimeModelDiscovery(provider)) {
    return resolveProviderRuntimeModelDiscoveryPending(provider, pendingByProvider, modelsQuery);
  }
  if (!modelsQuery) {
    return false;
  }
  return modelsQuery.isLoading || (modelsQuery.isFetching && modelsQuery.data === undefined);
}
