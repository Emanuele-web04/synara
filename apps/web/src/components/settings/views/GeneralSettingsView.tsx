// FILE: GeneralSettingsView.tsx
// Purpose: Settings › General: defaults for new chats, power, time format, and the tours.
// Layer: Settings view
// Exports: GeneralSettingsView

import { type AppSettingsBinding } from "~/appSettings";
import { KeepAwakeSettingsSection, RemoteAccessKeepAwakeRow } from "~/components/KeepAwakeControls";
import { AppTourSettingsRow } from "~/components/settings/AdvancedSettingsPanel";
import { DefaultNewChatAccountRow } from "~/components/settings/accounts/DefaultNewChatAccountRow";
import { SettingResetButton, SettingsSelectControl } from "~/components/settings/SettingControls";
import { SettingsRow, SettingsSection } from "~/components/settings/SettingsPanelPrimitives";
import { Button } from "~/components/ui/button";
import { SelectItem } from "~/components/ui/select";
import { useDesktopKeepAwake } from "~/hooks/useDesktopKeepAwake";
import { useKeepAwakeState } from "~/hooks/useKeepAwakeState";
import { useTranslation } from "~/i18n";
import { useOnboardingDialogStore } from "~/onboarding/onboardingDialogStore";

const TIMESTAMP_FORMAT_LABELS = {
  locale: "common:theme_systemDefault",
  "12-hour": "settings:12Hour",
  "24-hour": "settings:timestamp_24hour",
} as const;

export function GeneralSettingsView(binding: AppSettingsBinding) {
  const { settings, defaults, updateSettings } = binding;
  const { t } = useTranslation();
  const keepAwake = useKeepAwakeState();
  const desktopKeepAwake = useDesktopKeepAwake();
  return (
    <div className="space-y-6">
      <SettingsSection title="settings:general_newChats">
        <DefaultNewChatAccountRow
          settings={settings}
          defaults={defaults}
          updateSettings={updateSettings}
        />

        <SettingsRow
          id="setting-new-threads"
          title="settings:general_newThreads"
          description="settings:pickTheDefaultWorkspaceModeForNewlyCreatedDraft"
          resetAction={
            settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ? (
              <SettingResetButton
                label={t("settings:newThreads")}
                onClick={() =>
                  updateSettings({
                    defaultThreadEnvMode: defaults.defaultThreadEnvMode,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.defaultThreadEnvMode}
              onValueChange={(value) => {
                if (value !== "local" && value !== "worktree") return;
                updateSettings({
                  defaultThreadEnvMode: value,
                });
              }}
              ariaLabel={t("settings:general_defaultThreadMode")}
              valueContent={
                settings.defaultThreadEnvMode === "worktree"
                  ? t("chat:general_newWorktree")
                  : t("computer:worktreeMode_local")
              }
            >
              <SelectItem hideIndicator value="local">
                {t("computer:worktreeMode_local")}
              </SelectItem>
              <SelectItem hideIndicator value="worktree">
                {t("chat:general_newWorktree")}
              </SelectItem>
            </SettingsSelectControl>
          }
        />
      </SettingsSection>

      <KeepAwakeSettingsSection
        title="settings:general_power"
        state={keepAwake}
        mode={settings.keepAwakeMode}
        defaultMode={defaults.keepAwakeMode}
        onSelectMode={(keepAwakeMode) => updateSettings({ keepAwakeMode })}
        extraRows={
          desktopKeepAwake.state ? <RemoteAccessKeepAwakeRow keepAwake={desktopKeepAwake} /> : null
        }
      />

      <SettingsSection title="settings:general_time">
        <SettingsRow
          id="setting-time-format"
          title="settings:changed_timeFormat"
          description="settings:systemDefaultFollowsYourBrowserOrOSClockPreference"
          resetAction={
            settings.timestampFormat !== defaults.timestampFormat ? (
              <SettingResetButton
                label={t("settings:timeFormat")}
                onClick={() =>
                  updateSettings({
                    timestampFormat: defaults.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value !== "locale" && value !== "12-hour" && value !== "24-hour") {
                  return;
                }
                updateSettings({
                  timestampFormat: value,
                });
              }}
              ariaLabel={t("settings:timestampFormat")}
              triggerClassName="w-full sm:w-40"
              valueContent={t(TIMESTAMP_FORMAT_LABELS[settings.timestampFormat])}
            >
              <SelectItem hideIndicator value="locale">
                {t(TIMESTAMP_FORMAT_LABELS.locale)}
              </SelectItem>
              <SelectItem hideIndicator value="12-hour">
                {t(TIMESTAMP_FORMAT_LABELS["12-hour"])}
              </SelectItem>
              <SelectItem hideIndicator value="24-hour">
                {t(TIMESTAMP_FORMAT_LABELS["24-hour"])}
              </SelectItem>
            </SettingsSelectControl>
          }
        />
      </SettingsSection>

      <SettingsSection title="settings:general_gettingStarted">
        <SettingsRow
          id="setting-welcome-tour"
          title="settings:welcomeTour"
          description="settings:replayTheFirstRunSetupFeatureTourProviderSelection"
          control={
            <Button
              variant="outline"
              onClick={() => useOnboardingDialogStore.getState().openDialog()}
            >
              {t("settings:openWelcomeTour")}
            </Button>
          }
        />
        <AppTourSettingsRow />
      </SettingsSection>
    </div>
  );
}
