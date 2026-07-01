// FILE: useProviderStatusesForLocalConfig.ts
// Purpose: Normalize server provider health against local binary overrides for composer-like sends.
// Layer: Web hook
// Depends on: server config query, app settings, and provider availability normalization.

import type { ServerProviderStatus } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { getCustomBinaryPathForProviderInstance, useAppSettings } from "../appSettings";
import { loadConfirmedCustomBinaryPaths } from "../confirmedCustomBinaryPathStore";
import {
  normalizeProviderStatusForLocalConfig,
  providerStatusInstanceKey,
} from "../lib/providerAvailability";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { isProviderKind } from "../providerOrdering";

const EMPTY_PROVIDER_STATUSES: ServerProviderStatus[] = [];

export function useProviderStatusesForLocalConfig(): readonly ServerProviderStatus[] {
  const { settings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());

  return useMemo(() => {
    const confirmedCustomBinaryPaths = loadConfirmedCustomBinaryPaths();
    return (serverConfigQuery.data?.providers ?? EMPTY_PROVIDER_STATUSES)
      .map((status) => {
        const provider = status.driver ?? status.provider;
        if (!isProviderKind(provider)) {
          return status;
        }
        const providerInstanceId = providerStatusInstanceKey(status);
        return normalizeProviderStatusForLocalConfig({
          provider,
          status,
          customBinaryPath: getCustomBinaryPathForProviderInstance(
            settings,
            provider,
            providerInstanceId,
          ),
          confirmedCustomBinaryPath: confirmedCustomBinaryPaths[providerInstanceId],
        });
      })
      .flatMap((status) => (status ? [status] : []));
  }, [serverConfigQuery.data?.providers, settings]);
}
