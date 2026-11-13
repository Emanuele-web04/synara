// FILE: ProviderInstallFieldControl.tsx
// Purpose: One provider-wide install setting (a CLI path, endpoint, password, or switch)
//          bound straight to app settings. Used by the Agents list and by the default
//          account's sign-in folder on the Accounts page.
// Layer: Settings UI
// Exports: ProviderInstallFieldControl

import type { AppSettings } from "~/appSettings";
import { useTranslation } from "~/i18n";

import { Switch } from "../../ui/switch";
import { DebouncedSettingTextInput } from "../DebouncedSettingTextInput";
import type { ProviderInstallField } from "./providerInstallSettings";

export function ProviderInstallFieldControl(props: {
  field: ProviderInstallField;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
}) {
  const { t } = useTranslation();

  const id = `provider-install-${props.field.settingsKey}`;
  if (props.field.kind === "boolean") {
    return (
      <label
        htmlFor={id}
        className="flex items-start justify-between gap-3 rounded-md border border-border/70 bg-background/60 px-3 py-2"
      >
        <span className="min-w-0">
          <span className="block text-ui leading-snug font-medium text-foreground">
            {t(props.field.label)}
          </span>
          <span className="mt-1 block text-ui leading-snug text-muted-foreground">
            {typeof props.field.description === "string"
              ? t(props.field.description)
              : props.field.description(t)}
          </span>
        </span>
        <Switch
          id={id}
          checked={props.settings[props.field.settingsKey]}
          onCheckedChange={(checked) =>
            props.updateSettings({ [props.field.settingsKey]: Boolean(checked) })
          }
        />
      </label>
    );
  }

  const configured =
    props.field.kind === "password" ? props.settings[props.field.configuredKey] : false;
  const isPassword = props.field.kind === "password";
  return (
    <label htmlFor={id} className="block">
      <span className="block text-ui leading-snug font-medium text-foreground">
        {t(props.field.label)}
      </span>
      <DebouncedSettingTextInput
        id={id}
        size="sm"
        variant="soft"
        className="mt-1"
        value={isPassword ? "" : props.settings[props.field.settingsKey]}
        onCommit={(nextValue) =>
          props.updateSettings({ [props.field.settingsKey]: nextValue } as Partial<AppSettings>)
        }
        placeholder={
          isPassword && configured
            ? t("settings:configuredEnterAReplacementOrLeaveBlank")
            : t(props.field.placeholder)
        }
        type={isPassword ? "password" : undefined}
        autoComplete={isPassword ? "new-password" : undefined}
        spellCheck={false}
      />
      <span className="mt-1 block text-ui leading-snug text-muted-foreground">
        {typeof props.field.description === "string"
          ? t(props.field.description)
          : props.field.description(t)}
      </span>
    </label>
  );
}
