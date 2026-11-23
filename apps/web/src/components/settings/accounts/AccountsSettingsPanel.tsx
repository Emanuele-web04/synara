// FILE: AccountsSettingsPanel.tsx
// Purpose: Settings → Accounts. Every signed-in (or not yet signed-in) account of every
//          enabled agent in one place, and one account's detail view. Built from the
//          account list and editor and the Usage page's account card; this file fetches
//          usage once, lays them out, and routes between the list and an account.
// Layer: Settings panel
// Exports: AccountsSettingsPanel, AccountsSettingsPanelProps

import { PROVIDER_DISPLAY_NAMES, type ServerProviderUsageSnapshot } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  getProviderInstanceOptions,
  type AppSettings,
  type AppSettingsBinding,
} from "~/appSettings";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useTranslation } from "~/i18n";
import { ChevronLeftIcon } from "~/lib/icons";
import { isProviderListedOnAccounts, isProviderOnAccountsPage } from "~/lib/providerAccountSummary";
import { providerStatusesByInstance } from "~/lib/providerAvailability";
import { serverAllProviderUsageQueryOptions } from "~/lib/serverReactQuery";

import { Button } from "../../ui/button";
import { ProviderUsageCard } from "../ProviderUsageSettingsPanel";
import { PROVIDER_INSTALL_SETTINGS } from "../providers/providerInstallSettings";
import { SettingsEmptyState } from "../SettingsPanelPrimitives";
import { ProviderAccountEditor } from "./ProviderAccountEditor";
import { ProviderAccountsList } from "./ProviderAccountsList";

export type AccountsSettingsPanelProps = AppSettingsBinding & {
  readonly active: boolean;
  /** The account whose detail view is open; null shows every account. */
  readonly accountId: string | null;
  readonly updateSettingsAndWait: (patch: Partial<AppSettings>) => Promise<void>;
  /** Opens an account's detail view, or returns to the list with null. */
  readonly onOpenAccount: (instanceId: string | null) => void;
};

export function AccountsSettingsPanel({
  settings,
  updateSettings,
  updateSettingsAndWait,
  active,
  accountId,
  onOpenAccount,
}: AccountsSettingsPanelProps) {
  const { t } = useTranslation();
  const statuses = useProviderStatusesForLocalConfig();
  const statusByInstance = useMemo(() => providerStatusesByInstance(statuses), [statuses]);
  // One usage fetch for the whole page; nothing is fetched while the page is closed.
  const usageQuery = useQuery(serverAllProviderUsageQueryOptions({ enabled: active }));
  const usageByInstance = useMemo(
    () =>
      new Map<string, ServerProviderUsageSnapshot>(
        (usageQuery.data ?? []).map((snapshot) => [
          snapshot.instanceId ?? snapshot.provider,
          snapshot,
        ]),
      ),
    [usageQuery.data],
  );

  if (!active) return null;

  const enabledConfigs = PROVIDER_INSTALL_SETTINGS.filter((config) =>
    isProviderOnAccountsPage(config.provider, settings.disabledProviders),
  );

  if (accountId !== null) {
    const account = getProviderInstanceOptions(settings).find(
      (option) => String(option.instanceId) === accountId,
    );
    const config = account
      ? enabledConfigs.find((entry) => entry.provider === account.provider)
      : undefined;
    const usageSnapshot = usageByInstance.get(accountId);
    return (
      <div className="space-y-6">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="-ml-2"
          onClick={() => onOpenAccount(null)}
        >
          <ChevronLeftIcon className="size-3.5" />
          {t("settings:accounts_back")}
        </Button>
        {account && usageSnapshot ? (
          <ProviderUsageCard
            snapshot={usageSnapshot}
            // The card already names the agent; an unnamed default account adds nothing.
            accountLabel={
              account.label === PROVIDER_DISPLAY_NAMES[account.provider] ? null : account.label
            }
          />
        ) : null}
        {account && config ? (
          <ProviderAccountEditor
            accountId={accountId}
            config={config}
            providerStatusByInstance={statusByInstance}
            usageByInstance={usageByInstance}
            settings={settings}
            updateSettings={updateSettings}
            updateSettingsAndWait={updateSettingsAndWait}
            onAccountRemoved={() => onOpenAccount(null)}
          />
        ) : (
          <SettingsEmptyState>{t("settings:accounts_notFound")}</SettingsEmptyState>
        )}
      </div>
    );
  }

  if (enabledConfigs.length === 0) {
    return <SettingsEmptyState>{t("settings:accounts_noProviders")}</SettingsEmptyState>;
  }

  const accounts = getProviderInstanceOptions(settings);
  const isListed = (provider: (typeof enabledConfigs)[number]["provider"]) =>
    isProviderListedOnAccounts(provider, statusByInstance, accounts);
  const listedConfigs = enabledConfigs.filter((config) => isListed(config.provider));
  const notInstalled = enabledConfigs.filter((config) => !isListed(config.provider));

  return (
    <div className="space-y-6">
      {listedConfigs.map((config) => (
        <ProviderAccountsList
          key={config.provider}
          provider={config.provider}
          providerStatusByInstance={statusByInstance}
          usageByInstance={usageByInstance}
          settings={settings}
          updateSettings={updateSettings}
          updateSettingsAndWait={updateSettingsAndWait}
          onOpenAccount={onOpenAccount}
        />
      ))}
      <div className="space-y-1.5 px-2 text-ui-sm leading-relaxed text-muted-foreground">
        {notInstalled.length > 0 ? (
          <p>
            {t("settings:accounts_notInstalled", {
              providers: notInstalled
                .map((config) => PROVIDER_DISPLAY_NAMES[config.provider])
                .join(", "),
            })}
          </p>
        ) : null}
        <p>{t("settings:accounts_footnote")}</p>
      </div>
    </div>
  );
}
