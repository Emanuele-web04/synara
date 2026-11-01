import type { KeepAwakeMode, ServerKeepAwakeState } from "@synara/contracts";
import { localizedKeepAwakeModeOptions, keepAwakeStatusLabel } from "~/lib/keepAwake";
import { SettingResetButton, SettingsSegmentedControl } from "./settings/SettingControls";
import { SettingsRow, SettingsSection } from "./settings/SettingsPanelPrimitives";
import { useTranslation } from "~/i18n";

export function KeepAwakeSettingsSection({
  state,
  mode,
  defaultMode,
  onSelectMode,
}: {
  state: ServerKeepAwakeState | null;
  mode: KeepAwakeMode;
  defaultMode: KeepAwakeMode;
  onSelectMode: (mode: KeepAwakeMode) => void;
}) {
  const { t } = useTranslation();
  const options = localizedKeepAwakeModeOptions(t);

  if (!state?.available) return null;
  return (
    <SettingsSection title={t("common:themeOptions_system")}>
      <SettingsRow
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
    </SettingsSection>
  );
}
