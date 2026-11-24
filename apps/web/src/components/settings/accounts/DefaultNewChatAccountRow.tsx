// FILE: DefaultNewChatAccountRow.tsx
// Purpose: Settings row that picks the agent and account (provider instance) new chats
//   start on until the user picks another in the model picker.
// Layer: Settings UI
// Depends on: provider instance options, resolveNewChatDefault, shared settings controls.

import { PROVIDER_DISPLAY_NAMES } from "@synara/contracts";
import { useMemo } from "react";

import {
  getProviderInstanceOptions,
  resolveNewChatDefault,
  type AppSettingsBinding,
  type ProviderInstanceOption,
} from "~/appSettings";
import { VISIBLE_PROVIDER_DESCRIPTORS } from "~/betaFeatures";
import { useTranslation } from "~/i18n";
import { providerAccountQualifiedLabel } from "~/lib/providerInstancePresentation";

import { ProviderOptionLabel } from "../../ProviderIcon";
import { SelectItem } from "../../ui/select";
import { SettingResetButton, SettingsSelectControl } from "../SettingControls";
import { SettingsRow } from "../SettingsPanelPrimitives";

interface NewChatAccountOption {
  readonly account: ProviderInstanceOption;
  readonly label: string;
}

// Every enabled account of every enabled, visible agent, in the agent order Settings uses.
function listNewChatAccountOptions(
  settings: AppSettingsBinding["settings"],
): NewChatAccountOption[] {
  const accounts = getProviderInstanceOptions(settings).filter((account) => account.enabled);
  return VISIBLE_PROVIDER_DESCRIPTORS.flatMap(({ kind }) => {
    if (settings.disabledProviders.includes(kind)) return [];
    const providerAccounts = accounts.filter((account) => account.provider === kind);
    const providerLabel = PROVIDER_DISPLAY_NAMES[kind];
    return providerAccounts.map((account) => ({
      account,
      // A lone default account is just the agent; otherwise name the account too.
      label:
        account.isDefault && providerAccounts.length === 1
          ? providerLabel
          : providerAccountQualifiedLabel(providerLabel, account.label),
    }));
  });
}

export function DefaultNewChatAccountRow({
  settings,
  defaults,
  updateSettings,
}: AppSettingsBinding) {
  const { t } = useTranslation();
  const options = useMemo(() => listNewChatAccountOptions(settings), [settings]);
  // resolveNewChatDefault drops a stored account that is gone, off, or on another agent.
  // A stored account that no longer resolves leaves the selection empty.
  const resolved = resolveNewChatDefault(settings);
  const selectedInstanceId =
    resolved.defaultProviderInstanceId ??
    (settings.defaultProviderInstanceId.trim() ? null : resolved.defaultProvider);
  const selected = options.find(({ account }) => account.instanceId === selectedInstanceId);
  const isDirty =
    settings.defaultProvider !== defaults.defaultProvider ||
    settings.defaultProviderInstanceId !== defaults.defaultProviderInstanceId;

  return (
    <SettingsRow
      id="setting-default-provider"
      title="settings:general_newChatAccount"
      description="settings:general_newChatAccountDescription"
      resetAction={
        isDirty ? (
          <SettingResetButton
            label={t("settings:general_newChatAccountResetLabel")}
            onClick={() =>
              updateSettings({
                defaultProvider: defaults.defaultProvider,
                defaultProviderInstanceId: defaults.defaultProviderInstanceId,
              })
            }
          />
        ) : null
      }
      control={
        <SettingsSelectControl
          value={selected ? selected.account.instanceId : null}
          disabled={options.length === 0}
          onValueChange={(value) => {
            const next = options.find(({ account }) => account.instanceId === value)?.account;
            if (!next) return;
            updateSettings({
              defaultProvider: next.provider,
              defaultProviderInstanceId: next.instanceId,
            });
          }}
          ariaLabel={t("settings:general_newChatAccount")}
          valueContent={
            selected ? (
              <ProviderOptionLabel provider={selected.account.provider} label={selected.label} />
            ) : (
              t("settings:general_newChatAccountChoose")
            )
          }
        >
          {options.map(({ account, label }) => (
            <SelectItem hideIndicator key={account.instanceId} value={account.instanceId}>
              <ProviderOptionLabel provider={account.provider} label={label} />
            </SelectItem>
          ))}
        </SettingsSelectControl>
      }
    />
  );
}
