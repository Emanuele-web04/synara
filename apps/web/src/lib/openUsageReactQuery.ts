import type { ProviderKind } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

import { openUsageProviderIdForProvider } from "./openUsageRateLimits";

const OPEN_USAGE_BASE_URL = "http://127.0.0.1:6736";
const OPEN_USAGE_ENABLED_STORAGE_KEY = "t3code.openUsage.enabled";

function isOpenUsagePollingEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem(OPEN_USAGE_ENABLED_STORAGE_KEY) === "true";
}

export const openUsageQueryKeys = {
  all: ["openUsage"] as const,
  provider: (provider: ProviderKind | null | undefined) =>
    ["openUsage", "provider", provider ?? null] as const,
};

export function openUsageProviderSnapshotQueryOptions(provider: ProviderKind | null | undefined) {
  const providerId = openUsageProviderIdForProvider(provider);
  const openUsageEnabled = isOpenUsagePollingEnabled();

  return queryOptions({
    queryKey: openUsageQueryKeys.provider(provider),
    enabled: openUsageEnabled && providerId !== null,
    staleTime: 15_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async (): Promise<unknown | null> => {
      if (!providerId) return null;

      try {
        const response = await fetch(`${OPEN_USAGE_BASE_URL}/v1/usage/${providerId}`);
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
    },
  });
}
