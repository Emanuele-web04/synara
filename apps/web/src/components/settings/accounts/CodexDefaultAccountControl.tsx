// FILE: CodexDefaultAccountControl.tsx
// Purpose: The legacy "Codex account for new threads" picker, shown on the default Codex
//          account while migrated Codex accounts still exist.
// Layer: Settings UI
// Exports: CodexDefaultAccountControl

import { PROVIDER_DISPLAY_NAMES } from "@synara/contracts";

import { getCodexAccountOptions, type AppSettings } from "~/appSettings";
import { useTranslation } from "~/i18n";

import { SelectItem } from "../../ui/select";
import { SettingsSelectControl } from "../SettingControls";

// Settings written before accounts became provider instances also store which Codex
// account new threads start on. Only those settings still need the choice surfaced.
export function CodexDefaultAccountControl(props: {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
}) {
  const { t } = useTranslation();

  // The default account goes by the provider's name here too, as in the account list.
  const accountOptions = getCodexAccountOptions(props.settings).map((account) =>
    account.isDefault ? { ...account, label: PROVIDER_DISPLAY_NAMES.codex } : account,
  );
  const selectedAccountLabel =
    accountOptions.find((account) => account.id === props.settings.selectedCodexAccountId)?.label ??
    PROVIDER_DISPLAY_NAMES.codex;

  return (
    <div className="space-y-1">
      <span className="block text-ui-sm font-medium text-foreground">
        {t("settings:codexAccountForNewThreads")}
      </span>
      <SettingsSelectControl
        value={props.settings.selectedCodexAccountId}
        onValueChange={(selectedCodexAccountId) => props.updateSettings({ selectedCodexAccountId })}
        ariaLabel={t("settings:codexAccountForNewThreads")}
        triggerClassName="w-full"
        valueContent={<span className="truncate">{selectedAccountLabel}</span>}
      >
        {accountOptions.map((account) => (
          <SelectItem hideIndicator key={account.id} value={account.id}>
            <span className="truncate">{account.label}</span>
          </SelectItem>
        ))}
      </SettingsSelectControl>
      <span className="block text-ui-sm text-muted-foreground">
        {t("settings:usedUntilYouPickAnotherAccountInTheModel")}
      </span>
    </div>
  );
}
