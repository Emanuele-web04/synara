import type { ServerProviderStatus } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";

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
  const disabledProviders = new Set(settings.disabledProviders);

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
        disabled: disabledProviders.has(provider),
      });
    })
    .flatMap((status) => (status ? [status] : []));
}
