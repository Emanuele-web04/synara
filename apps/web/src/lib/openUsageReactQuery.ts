import type { ProviderKind } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

import { openUsageProviderIdForProvider } from "./openUsageRateLimits";
import {
  normalizeOpenUsageProviderSnapshots,
  type OpenUsageProviderSnapshot,
} from "./openUsageSnapshots";

export const OPEN_USAGE_BASE_URL = "http://127.0.0.1:6736";
export const CROSSUSAGE_PROJECT_URL = "https://github.com/barramee27/crossusage";

export const openUsageQueryKeys = {
  all: ["openUsage"] as const,
  providers: ["openUsage", "providers"] as const,
  provider: (provider: ProviderKind | null | undefined) =>
    ["openUsage", "provider", provider ?? null] as const,
};

async function fetchOpenUsageJson(path: string): Promise<unknown | null> {
  try {
    const response = await fetch(`${OPEN_USAGE_BASE_URL}${path}`);
    if (response.status === 204 || response.status === 404) {
      return null;
    }
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

export function openUsageAllProvidersQueryOptions() {
  return queryOptions({
    queryKey: openUsageQueryKeys.providers,
    staleTime: 15_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async (): Promise<OpenUsageProviderSnapshot[]> => {
      const payload = await fetchOpenUsageJson("/v1/usage");
      return normalizeOpenUsageProviderSnapshots(payload);
    },
  });
}

export function openUsageProviderSnapshotQueryOptions(provider: ProviderKind | null | undefined) {
  const providerId = openUsageProviderIdForProvider(provider);

  return queryOptions({
    queryKey: openUsageQueryKeys.provider(provider),
    enabled: providerId !== null,
    staleTime: 15_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async (): Promise<unknown | null> => {
      if (!providerId) return null;
      return fetchOpenUsageJson(`/v1/usage/${providerId}`);
    },
  });
}
