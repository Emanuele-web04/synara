import type { KeepAwakeMode, ServerKeepAwakeState } from "@synara/contracts";
import {
  KEEP_AWAKE_MODE_OPTIONS,
  KEEP_AWAKE_ROW_TITLE,
  keepAwakeStatusLabel,
} from "~/lib/keepAwake";
import { SettingResetButton, SettingsSegmentedControl } from "./settings/SettingControls";
import { SettingsRow, SettingsSection } from "./settings/SettingsPanelPrimitives";

const KEEP_AWAKE_SEGMENTED_OPTIONS = KEEP_AWAKE_MODE_OPTIONS.map((option) => ({
  value: option.value,
  label: option.label,
}));
const KEEP_AWAKE_ROW_DESCRIPTION = `Uses macOS caffeinate. ${KEEP_AWAKE_MODE_OPTIONS.map(
  (option) => `${option.label}: ${option.description}`,
).join(" ")}`;

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
  if (!state?.available) return null;
  return (
    <SettingsSection title="System">
      <SettingsRow
        title={KEEP_AWAKE_ROW_TITLE}
        description={KEEP_AWAKE_ROW_DESCRIPTION}
        status={state.error ?? keepAwakeStatusLabel(state)}
        resetAction={
          mode !== defaultMode ? (
            <SettingResetButton
              label="keep computer awake"
              onClick={() => onSelectMode(defaultMode)}
            />
          ) : null
        }
        control={
          <SettingsSegmentedControl
            value={mode}
            onValueChange={onSelectMode}
            ariaLabel={KEEP_AWAKE_ROW_TITLE}
            options={KEEP_AWAKE_SEGMENTED_OPTIONS}
          />
        }
      />
    </SettingsSection>
  );
}
