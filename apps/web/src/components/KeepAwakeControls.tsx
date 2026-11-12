import type { KeepAwakeMode, ServerKeepAwakeState } from "@synara/contracts";
import type { ReactNode } from "react";

import type { DesktopKeepAwake } from "~/hooks/useDesktopKeepAwake";
import { remoteAccessErrorMessage } from "~/lib/hosts/remoteAccess";
import { localizedKeepAwakeModeOptions, keepAwakeStatusLabel } from "~/lib/keepAwake";
import { SettingResetButton, SettingsSegmentedControl } from "./settings/SettingControls";
import { SettingsRow, SettingsSection } from "./settings/SettingsPanelPrimitives";
import { Switch } from "./ui/switch";
import { toastManager } from "./ui/toast";
import { useTranslation } from "~/i18n";

export function KeepAwakeSettingsSection({
  state,
  mode,
  defaultMode,
  onSelectMode,
  title,
  extraRows,
}: {
  state: ServerKeepAwakeState | null;
  mode: KeepAwakeMode;
  defaultMode: KeepAwakeMode;
  onSelectMode: (mode: KeepAwakeMode) => void;
  /** Section heading key (Settings › General › Power). */
  title: string;
  /** Further power rows in the same card (the desktop's remote-access keep-awake). */
  extraRows?: ReactNode;
}) {
  const { t } = useTranslation();
  const options = localizedKeepAwakeModeOptions(t);

  if (!state?.available) {
    return extraRows ? <SettingsSection title={t(title)}>{extraRows}</SettingsSection> : null;
  }
  return (
    <SettingsSection title={t(title)}>
      <SettingsRow
        id="setting-keep-computer-awake"
        title={t("settings:keepAwakeTitle")}
        description={t("settings:keepAwakeDescription")}
        status={state.error ?? keepAwakeStatusLabel(state, t)}
        resetAction={
          mode !== defaultMode ? (
            <SettingResetButton
              label={t("common:keepComputerAwake2")}
              onClick={() => onSelectMode(defaultMode)}
            />
          ) : null
        }
        control={
          <SettingsSegmentedControl
            value={mode}
            onValueChange={onSelectMode}
            ariaLabel={t("settings:keepAwakeTitle")}
            options={options}
          />
        }
      />
      {extraRows}
    </SettingsSection>
  );
}

/**
 * The desktop app's own keep-awake: stay up while plugged in so devices that control this
 * computer can reach it. Lives next to the agent keep-awake under General › Power.
 */
export function RemoteAccessKeepAwakeRow({ keepAwake }: { keepAwake: DesktopKeepAwake }) {
  const { t } = useTranslation();
  const state = keepAwake.state;
  if (!state) return null;
  return (
    <SettingsRow
      id="setting-stay-awake-for-remote-access"
      title="settings:keepAwake_remoteTitle"
      description="settings:keepAwake_remoteDescription"
      status={state.enabled && state.onBattery ? t("settings:keepAwake_remotePaused") : undefined}
      control={
        <Switch
          checked={state.enabled}
          aria-label={t("settings:keepAwake_remoteTitle")}
          onCheckedChange={(next) =>
            void keepAwake.setEnabled(next).catch((cause: unknown) =>
              toastManager.add({
                type: "error",
                title: t("settings:keepAwake_remoteFailed"),
                description: remoteAccessErrorMessage(
                  cause,
                  t("settings:keepAwake_remoteTryAgain"),
                ),
              }),
            )
          }
        />
      }
    />
  );
}
