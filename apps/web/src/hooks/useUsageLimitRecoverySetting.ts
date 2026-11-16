// FILE: useUsageLimitRecoverySetting.ts
// Purpose: Read and toggle this computer's "resume after usage limits" policy.
// Layer: Server settings hook shared by Settings → Usage and the composer usage-limit popover.

import { WS_USAGE_LIMIT_RECOVERY_CAPABILITY } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "~/i18n";
import { serverQueryKeys, serverSettingsQueryOptions } from "~/lib/serverReactQuery";
import {
  ensureNativeApi,
  onNativeApiServerCapabilitiesChange,
  readNativeApiServerCapability,
} from "~/nativeApi";
import { toastManager } from "~/components/ui/toast";

const subscribe = (listener: () => void) => onNativeApiServerCapabilitiesChange(listener);
const readCapability = () => readNativeApiServerCapability(WS_USAGE_LIMIT_RECOVERY_CAPABILITY);
const unavailable = () => false;

export interface UsageLimitRecoverySettingState {
  /** The connected server can own durable usage-limit waits. */
  readonly supported: boolean;
  readonly enabled: boolean;
  /** Settings are loaded and no update is in flight. */
  readonly ready: boolean;
  /** Resolves true once the server accepted the new policy. */
  readonly setEnabled: (enabled: boolean) => Promise<boolean>;
}

export function useUsageLimitRecoverySetting(): UsageLimitRecoverySettingState {
  const { t } = useTranslation();
  const supported = useSyncExternalStore(subscribe, readCapability, unavailable);
  const queryClient = useQueryClient();
  const settings = useQuery(serverSettingsQueryOptions());
  const mutationInFlight = useRef(false);
  const [pending, setPending] = useState(false);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      if (mutationInFlight.current) return false;
      mutationInFlight.current = true;
      setPending(true);
      try {
        const next = await ensureNativeApi().server.updateSettings({
          autoResumeAfterUsageLimits: enabled,
        });
        queryClient.setQueryData(serverQueryKeys.settings(), next);
        return true;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("settings:couldNotUpdateUsageLimitRecovery"),
          description: error instanceof Error ? error.message : undefined,
        });
        await queryClient
          .invalidateQueries({ queryKey: serverQueryKeys.settings() })
          .catch(() => undefined);
        return false;
      } finally {
        mutationInFlight.current = false;
        setPending(false);
      }
    },
    [queryClient, t],
  );

  return {
    supported,
    enabled: settings.data?.autoResumeAfterUsageLimits === true,
    ready: settings.data !== undefined && !pending,
    setEnabled,
  };
}
