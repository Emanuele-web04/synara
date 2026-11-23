// FILE: AutoEngineSettingsSection.tsx
// Purpose: Settings › Chats › "Auto engine": choose provider-native or the
// Synara-local approval gate for Auto runtime mode, tune its confidence bands,
// and download the on-device classifier model.

import {
  type AutoEngine,
  type AutoGateStatusView,
  type AutoGateThresholdPreset,
} from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SettingsSegmentedControl,
  SettingsSelectControl,
  type SettingsSegmentedOption,
} from "~/components/settings/SettingControls";
import { SettingsRow, SettingsSection } from "~/components/settings/SettingsPanelPrimitives";
import { Button } from "~/components/ui/button";
import { SelectItem } from "~/components/ui/select";
import { toastManager } from "~/components/ui/toast";
import { useTranslation } from "~/i18n";
import { ensureNativeApi } from "~/nativeApi";
import { serverQueryKeys, serverSettingsQueryOptions } from "~/lib/serverReactQuery";

const AUTO_ENGINE_OPTIONS = [
  { value: "native", label: "settings:autoEngineProviderNative" },
  { value: "local", label: "settings:autoEngineSynaraLocal" },
] as const satisfies ReadonlyArray<SettingsSegmentedOption<AutoEngine>>;

const THRESHOLD_PRESET_LABELS = {
  strict: "settings:autoGatePresetStrict",
  balanced: "settings:autoGatePresetBalanced",
  permissive: "settings:autoGatePresetPermissive",
} as const satisfies Record<AutoGateThresholdPreset, string>;

const autoGateStatusQueryOptions = {
  queryKey: ["server", "autoGateStatus"] as const,
  queryFn: (): Promise<AutoGateStatusView> => ensureNativeApi().server.getAutoGateStatus(),
};

function modelStateLabel(state: AutoGateStatusView["model"]["state"]) {
  switch (state) {
    case "not-downloaded":
      return "settings:autoGateModelNotDownloaded";
    case "downloading":
      return "settings:autoGateModelDownloading";
    case "ready":
      return "settings:autoGateModelReady";
    case "error":
      return "settings:autoGateModelError";
  }
}

export function AutoEngineSettingsSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settings = useQuery(serverSettingsQueryOptions());
  const autoEngine = settings.data?.autoEngine ?? "native";
  const thresholdPreset = settings.data?.autoGateThresholdPreset ?? "balanced";

  const gateStatus = useQuery({
    ...autoGateStatusQueryOptions,
    enabled: autoEngine === "local",
    refetchInterval: (query) => (query.state.data?.model.state === "downloading" ? 2000 : false),
  });
  const gateModel = gateStatus.data?.model;

  const updateSettings = async (patch: {
    autoEngine?: AutoEngine;
    autoGateThresholdPreset?: AutoGateThresholdPreset;
  }) => {
    try {
      const next = await ensureNativeApi().server.updateSettings(patch);
      queryClient.setQueryData(serverQueryKeys.settings(), next);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("settings:couldNotUpdateAutoEngine"),
        description: error instanceof Error ? error.message : undefined,
      });
      await queryClient
        .invalidateQueries({ queryKey: serverQueryKeys.settings() })
        .catch(() => undefined);
    }
  };

  const downloadModel = async () => {
    try {
      await ensureNativeApi().server.downloadAutoGateModel();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("settings:couldNotDownloadAutoGateModel"),
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      await queryClient
        .invalidateQueries({ queryKey: autoGateStatusQueryOptions.queryKey })
        .catch(() => undefined);
    }
  };

  return (
    <SettingsSection title="settings:autoEngine">
      <SettingsRow
        id="setting-auto-engine"
        title="settings:autoEngine"
        description="settings:autoEngineDescription"
        control={
          <SettingsSegmentedControl
            value={autoEngine}
            onValueChange={(value) => void updateSettings({ autoEngine: value })}
            ariaLabel={t("settings:autoEngine")}
            options={AUTO_ENGINE_OPTIONS}
          />
        }
      />
      {autoEngine === "local" ? (
        <>
          <SettingsRow
            id="setting-auto-gate-preset"
            title="settings:autoGateConfidence"
            description="settings:autoGateConfidenceDescription"
            control={
              <SettingsSelectControl
                value={thresholdPreset}
                onValueChange={(value) => {
                  if (value !== "strict" && value !== "balanced" && value !== "permissive") {
                    return;
                  }
                  void updateSettings({ autoGateThresholdPreset: value });
                }}
                ariaLabel={t("settings:autoGateConfidence")}
                valueContent={t(THRESHOLD_PRESET_LABELS[thresholdPreset])}
              >
                <SelectItem hideIndicator value="strict">
                  {t(THRESHOLD_PRESET_LABELS.strict)}
                </SelectItem>
                <SelectItem hideIndicator value="balanced">
                  {t(THRESHOLD_PRESET_LABELS.balanced)}
                </SelectItem>
                <SelectItem hideIndicator value="permissive">
                  {t(THRESHOLD_PRESET_LABELS.permissive)}
                </SelectItem>
              </SettingsSelectControl>
            }
          />
          <SettingsRow
            id="setting-auto-gate-model"
            title="settings:autoGateModel"
            description="settings:autoGateModelDescription"
            status={t(modelStateLabel(gateModel?.state ?? "not-downloaded"), {
              progress:
                gateModel?.state === "downloading"
                  ? Math.round(gateModel.bytesDone / 1_000_000)
                  : 0,
            })}
            control={
              gateModel?.state !== "ready" ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={gateStatus.isFetching || gateModel?.state === "downloading"}
                  onClick={() => void downloadModel()}
                >
                  {t("settings:autoGateDownloadModel")}
                </Button>
              ) : undefined
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
