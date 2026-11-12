// FILE: BooleanSettingRow.tsx
// Purpose: The on/off settings row every settings view uses — a Switch bound to one boolean
//          app setting, with the standard reset-to-default affordance — and its compact twin
//          for a SettingsToggleGroup.
// Layer: Settings UI components
// Exports: BooleanSettingKey, BooleanSettingRow, BooleanSettingToggle

import type { AppSettings, AppSettingsBinding } from "~/appSettings";
import { useTranslation } from "~/i18n";
import { Switch } from "../ui/switch";
import { SettingResetButton } from "./SettingControls";
import { SettingsRow, SettingsToggleItem } from "./SettingsPanelPrimitives";

/** Keys of AppSettings whose value is a plain boolean — the ones a switch can drive. */
export type BooleanSettingKey = {
  [Key in keyof AppSettings]-?: AppSettings[Key] extends boolean ? Key : never;
}[keyof AppSettings];

type BooleanSettingProps = AppSettingsBinding & {
  readonly settingKey: BooleanSettingKey;
  /** Stable search/deep-link anchor (`setting-…`). */
  readonly id: string;
  /** Catalog keys; translated here. */
  readonly title: string;
  readonly description: string;
  /** What the reset button names ("Reset {resetLabel} to default"). */
  readonly resetLabel: string;
  readonly ariaLabel: string;
};

function booleanSettingState({
  settings,
  defaults,
  updateSettings,
  settingKey,
}: Pick<BooleanSettingProps, "settings" | "defaults" | "updateSettings" | "settingKey">) {
  return {
    checked: settings[settingKey],
    isChanged: settings[settingKey] !== defaults[settingKey],
    set: (value: boolean) => updateSettings({ [settingKey]: value } as Partial<AppSettings>),
    reset: () => updateSettings({ [settingKey]: defaults[settingKey] } as Partial<AppSettings>),
  };
}

export function BooleanSettingRow(props: BooleanSettingProps) {
  const { t } = useTranslation();
  const setting = booleanSettingState(props);
  return (
    <SettingsRow
      id={props.id}
      title={props.title}
      description={props.description}
      resetAction={
        setting.isChanged ? (
          <SettingResetButton label={t(props.resetLabel)} onClick={setting.reset} />
        ) : null
      }
      control={
        <Switch
          checked={setting.checked}
          onCheckedChange={(checked) => setting.set(Boolean(checked))}
          aria-label={t(props.ariaLabel)}
        />
      }
    />
  );
}

/** Compact twin for a SettingsToggleGroup; Restore defaults covers its reset. */
export function BooleanSettingToggle(props: Omit<BooleanSettingProps, "resetLabel">) {
  const { t } = useTranslation();
  const setting = booleanSettingState(props);
  return (
    <SettingsToggleItem
      id={props.id}
      title={props.title}
      description={props.description}
      control={
        <Switch
          checked={setting.checked}
          onCheckedChange={(checked) => setting.set(Boolean(checked))}
          aria-label={t(props.ariaLabel)}
        />
      }
    />
  );
}
