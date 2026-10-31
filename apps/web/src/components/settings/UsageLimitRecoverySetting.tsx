// FILE: UsageLimitRecoverySetting.tsx
// Purpose: Opt into host-owned usage-limit recovery without changing another computer's policy.

import { WS_USAGE_LIMIT_RECOVERY_CAPABILITY } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "~/i18n";
import { serverQueryKeys, serverSettingsQueryOptions } from "~/lib/serverReactQuery";
import {
  ensureNativeApi,
  onNativeApiServerCapabilitiesChange,
  readNativeApiServerCapability,
} from "~/nativeApi";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./SettingsPanelPrimitives";

const subscribe = (listener: () => void) => onNativeApiServerCapabilitiesChange(listener);
const readCapability = () => readNativeApiServerCapability(WS_USAGE_LIMIT_RECOVERY_CAPABILITY);
const unavailable = () => false;

export function UsageLimitRecoverySetting() {
  const { t } = useTranslation();
  const supported = useSyncExternalStore(subscribe, readCapability, unavailable);
  const queryClient = useQueryClient();
  const settings = useQuery(serverSettingsQueryOptions());
  const mutationInFlight = useRef(false);
  const [pending, setPending] = useState(false);

  if (!supported) return null;

  const update = async (enabled: boolean) => {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setPending(true);
    try {
      const next = await ensureNativeApi().server.updateSettings({
        autoResumeAfterUsageLimits: enabled,
      });
      queryClient.setQueryData(serverQueryKeys.settings(), next);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("settings:couldNotUpdateUsageLimitRecovery"),
        description: error instanceof Error ? error.message : undefined,
      });
      await queryClient
        .invalidateQueries({ queryKey: serverQueryKeys.settings() })
        .catch(() => undefined);
    } finally {
      mutationInFlight.current = false;
      setPending(false);
    }
  };

  return (
    <SettingsRow
      id="setting-resume-after-usage-limits"
      title="settings:resumeAfterUsageLimits"
      description="settings:resumeAfterUsageLimitsDescription"
      control={
        <Switch
          checked={settings.data?.autoResumeAfterUsageLimits === true}
          disabled={!settings.data || pending}
          onCheckedChange={(checked) => void update(Boolean(checked))}
          aria-label={t("settings:resumeAfterUsageLimits")}
        />
      }
    />
  );
}
