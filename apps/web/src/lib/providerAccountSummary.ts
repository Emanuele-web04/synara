// FILE: providerAccountSummary.ts
// Purpose: What the settings sidebar needs to know about agent accounts — how many still
//          need a sign-in (the Accounts badge) and each account's searchable name, email,
//          and agent — without loading the settings panels.
// Layer: UI support
// Exports: summarizeProviderAccounts, isProviderOnAccountsPage, isProviderListedOnAccounts

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";

import {
  getProviderInstanceOptions,
  type AppSettings,
  type ProviderInstanceOption,
} from "~/appSettings";
import { isBetaFeatureOn } from "~/betaFeatures";
import { providerStatusesByInstance } from "~/lib/providerAvailability";
import { providerAccountIdentityLabel } from "~/lib/providerInstancePresentation";
import { providerAccountNeedsSignIn } from "~/lib/providerSetupStatus";
import type { SettingsSearchAccount } from "~/settingsSearchIndex";

export interface ProviderAccountSummary {
  /** Enabled accounts of enabled agents whose CLI reports no sign-in. */
  readonly needingSignIn: number;
  readonly searchAccounts: ReadonlyArray<SettingsSearchAccount>;
}

/**
 * Whether the Accounts page covers an agent at all: offered in this build (Beta-only
 * agents are hidden on Stable) and not disabled.
 */
export function isProviderOnAccountsPage(
  provider: ProviderKind,
  disabledProviders: ReadonlyArray<ProviderKind>,
): boolean {
  return isBetaFeatureOn(provider) && !disabledProviders.includes(provider);
}

/**
 * Whether the Accounts page gives an agent its own card. An agent whose CLI is missing has
 * nothing to sign in to, so it is only named in a note — unless it already has an account
 * of its own.
 */
export function isProviderListedOnAccounts(
  provider: ProviderKind,
  statusByInstance: ReadonlyMap<string, ServerProviderStatus>,
  accounts: ReadonlyArray<ProviderInstanceOption>,
): boolean {
  return (
    statusByInstance.get(provider)?.available !== false ||
    accounts.some((account) => account.provider === provider && !account.isDefault)
  );
}

export function summarizeProviderAccounts(
  settings: AppSettings,
  statuses: ReadonlyArray<ServerProviderStatus>,
): ProviderAccountSummary {
  const statusByInstance = providerStatusesByInstance(statuses);
  const allAccounts = getProviderInstanceOptions(settings);
  // Exactly the accounts the Accounts page lists.
  const accounts = allAccounts.filter(
    (account) =>
      isProviderOnAccountsPage(account.provider, settings.disabledProviders) &&
      isProviderListedOnAccounts(account.provider, statusByInstance, allAccounts),
  );
  let needingSignIn = 0;
  const searchAccounts = accounts.map((account) => {
    const status = statusByInstance.get(String(account.instanceId));
    if (providerAccountNeedsSignIn({ status, enabled: account.enabled })) needingSignIn += 1;
    return {
      instanceId: String(account.instanceId),
      label: account.label,
      providerLabel: PROVIDER_DISPLAY_NAMES[account.provider],
      identity: providerAccountIdentityLabel(status),
    };
  });
  return { needingSignIn, searchAccounts };
}
