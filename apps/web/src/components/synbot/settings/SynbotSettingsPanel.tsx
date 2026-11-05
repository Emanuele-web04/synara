// FILE: SynbotSettingsPanel.tsx
// Purpose: Settings → SynBot (Beta): how bots recap, whether they control chats without asking,
//          the merge proof, and how many tasks run at once. Values come from the live SynBot
//          store; each change is one `bots.updateSettings` call (the server owns the values).
// Layer: Settings UI panel
// Exports: SynbotSettingsPanel

import {
  BOT_PARALLEL_TASKS_MAX,
  BOT_PARALLEL_TASKS_MIN,
  DEFAULT_BOT_SETTINGS,
  type BotRecapMode,
  type BotsUpdateSettingsInput,
} from "@synara/contracts";
import { useEffect, useState } from "react";

import { SettingResetButton, SettingsSelectControl } from "~/components/settings/SettingControls";
import {
  SettingsEmptyState,
  SettingsSection,
  SettingsRow,
} from "~/components/settings/SettingsPanelPrimitives";
import { SelectItem } from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { useTranslation } from "~/i18n";
import { readNativeApi } from "~/nativeApi";
import { SETTINGS_TARGETS } from "~/settingsNavigation";
import { startSynbotLiveSync, useSynbotStore } from "~/synbot/synbotStore";

const RECAP_LABEL_KEYS: Record<BotRecapMode, string> = {
  request: "synbotEditor:recapRequest",
  task: "synbotEditor:recapTask",
};

const PARALLEL_TASK_OPTIONS = Array.from(
  { length: BOT_PARALLEL_TASKS_MAX - BOT_PARALLEL_TASKS_MIN + 1 },
  (_, index) => BOT_PARALLEL_TASKS_MIN + index,
);

export function SynbotSettingsPanel() {
  const { t } = useTranslation();
  const status = useSynbotStore((store) => store.status);
  const settings = useSynbotStore((store) => store.data.settings);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (useSynbotStore.getState().status === "idle") startSynbotLiveSync();
  }, []);

  if (status === "unavailable" || status === "error") {
    return (
      <SettingsEmptyState tone={status === "error" ? "destructive" : "muted"}>
        {status === "error" ? t("synbotEditor:settingsLoadFailed") : t("synbotEditor:unavailable")}
      </SettingsEmptyState>
    );
  }
  if (status !== "ready") {
    return (
      <SettingsEmptyState>
        <Spinner aria-label={t("synbotEditor:loading")} className="mx-auto size-4" />
      </SettingsEmptyState>
    );
  }

  const save = async (patch: BotsUpdateSettingsInput) => {
    const api = readNativeApi();
    if (!api || saving) return;
    setSaving(true);
    try {
      const next = await api.bots.updateSettings(patch);
      useSynbotStore.getState().applyEvent({ type: "settings-updated", settings: next });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("synbotEditor:settingsSaveFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const reset = (label: string, patch: BotsUpdateSettingsInput) => (
    <SettingResetButton label={label} onClick={() => void save(patch)} />
  );

  return (
    <div className="flex flex-col gap-7">
      <SettingsSection title="synbotEditor:settingsBotsSection">
        <SettingsRow
          id={SETTINGS_TARGETS.synbotRecap}
          title="synbotEditor:recap"
          description="synbotEditor:recapDescription"
          resetAction={
            settings.recapMode !== DEFAULT_BOT_SETTINGS.recapMode
              ? reset(t("synbotEditor:recap"), { recapMode: DEFAULT_BOT_SETTINGS.recapMode })
              : null
          }
          control={
            <SettingsSelectControl
              value={settings.recapMode}
              valueContent={t(RECAP_LABEL_KEYS[settings.recapMode])}
              ariaLabel={t("synbotEditor:recap")}
              triggerClassName="w-full sm:w-56"
              disabled={saving}
              onValueChange={(value) => void save({ recapMode: value as BotRecapMode })}
            >
              {(Object.keys(RECAP_LABEL_KEYS) as BotRecapMode[]).map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {t(RECAP_LABEL_KEYS[mode])}
                </SelectItem>
              ))}
            </SettingsSelectControl>
          }
        />
        <SettingsRow
          id={SETTINGS_TARGETS.synbotControlChats}
          title="synbotEditor:controlChats"
          description="synbotEditor:controlChatsDescription"
          resetAction={
            settings.controlWithoutAsking !== DEFAULT_BOT_SETTINGS.controlWithoutAsking
              ? reset(t("synbotEditor:controlChats"), {
                  controlWithoutAsking: DEFAULT_BOT_SETTINGS.controlWithoutAsking,
                })
              : null
          }
          control={
            <Switch
              checked={settings.controlWithoutAsking}
              disabled={saving}
              aria-label={t("synbotEditor:controlChats")}
              onCheckedChange={(checked) => void save({ controlWithoutAsking: checked })}
            />
          }
        />
        <SettingsRow
          id={SETTINGS_TARGETS.synbotMergeProof}
          title="synbotEditor:mergeProof"
          description="synbotEditor:mergeProofDescription"
          resetAction={
            settings.mergeProofEnabled !== DEFAULT_BOT_SETTINGS.mergeProofEnabled
              ? reset(t("synbotEditor:mergeProof"), {
                  mergeProofEnabled: DEFAULT_BOT_SETTINGS.mergeProofEnabled,
                })
              : null
          }
          control={
            <Switch
              checked={settings.mergeProofEnabled}
              disabled={saving}
              aria-label={t("synbotEditor:mergeProof")}
              onCheckedChange={(checked) => void save({ mergeProofEnabled: checked })}
            />
          }
        />
        <SettingsRow
          id={SETTINGS_TARGETS.synbotParallelTasks}
          title="synbotEditor:parallelTasks"
          description="synbotEditor:parallelTasksDescription"
          resetAction={
            settings.maxParallelTasks !== DEFAULT_BOT_SETTINGS.maxParallelTasks
              ? reset(t("synbotEditor:parallelTasks"), {
                  maxParallelTasks: DEFAULT_BOT_SETTINGS.maxParallelTasks,
                })
              : null
          }
          control={
            <SettingsSelectControl
              value={String(settings.maxParallelTasks)}
              valueContent={String(settings.maxParallelTasks)}
              ariaLabel={t("synbotEditor:parallelTasks")}
              disabled={saving}
              onValueChange={(value) => void save({ maxParallelTasks: Number(value) })}
            >
              {PARALLEL_TASK_OPTIONS.map((count) => (
                <SelectItem key={count} value={String(count)}>
                  {count}
                </SelectItem>
              ))}
            </SettingsSelectControl>
          }
        />
      </SettingsSection>
    </div>
  );
}
