// FILE: AppRailUsage.logic.ts
// Purpose: Pure selection rules for the provider quota tiles at the bottom of the app rail.

import { t } from "~/i18n";
import type { ProviderInstanceId, ProviderKind } from "@synara/contracts";
import type { ResolvedProviderInstance } from "@synara/shared/providerInstances";
import { PROVIDER_USAGE_PROVIDERS, providerUsageDisplayName } from "@synara/shared/providerUsage";

import { providerAccountQualifiedLabel } from "~/lib/providerInstancePresentation";

/** The rail's fixed foot fits four tiles above the Help button; the items above them scroll. */
export const MAX_RAIL_USAGE_ACCOUNTS = 4;

/** At or below this the tile stops reading as a healthy meter. */
export const RAIL_USAGE_LOW_THRESHOLD = 20;

export type RailUsageState = "normal" | "low" | "exhausted" | "empty";

/** Tile state from the account's tightest remaining window; no reading at all is `empty`. */
export function railUsageState(remainingPercent: number | undefined): RailUsageState {
  if (remainingPercent === undefined) return "empty";
  if (remainingPercent <= 0) return "exhausted";
  if (remainingPercent <= RAIL_USAGE_LOW_THRESHOLD) return "low";
  return "normal";
}

export interface RailUsageAccount {
  readonly instance: ResolvedProviderInstance;
  readonly label: string;
  readonly dotted: boolean;
}

/** Enabled usage-capable accounts, named consistently in Settings and the rail. */
export function getRailUsageAccounts(
  instances: ReadonlyArray<ResolvedProviderInstance>,
  disabledProviders: ReadonlyArray<ProviderKind> = [],
  translate: typeof t = t,
): ReadonlyArray<RailUsageAccount> {
  return PROVIDER_USAGE_PROVIDERS.flatMap((provider) => {
    const accounts = instances.filter(
      (instance) =>
        instance.enabled &&
        instance.driver === provider &&
        !disabledProviders.includes(instance.driver),
    );
    const providerName = providerUsageDisplayName(provider);
    return accounts.map((instance) => {
      const showAccountName =
        !instance.isDefault || accounts.length > 1 || Boolean(instance.raw.displayName?.trim());
      const accountName =
        instance.isDefault && !instance.raw.displayName?.trim()
          ? translate("settings:defaultProviderAccount")
          : instance.displayName;
      return {
        instance,
        dotted: accounts.length > 1 && !instance.isDefault,
        label: showAccountName
          ? providerAccountQualifiedLabel(providerName, accountName)
          : providerName,
      };
    });
  });
}

/** Stored selection → unique available accounts, capped after dropping stale ids. */
export function resolveRailUsageAccounts(
  selected: ReadonlyArray<ProviderInstanceId>,
  available: ReadonlyArray<RailUsageAccount>,
): ReadonlyArray<RailUsageAccount> {
  const byId = new Map(available.map((account) => [account.instance.instanceId, account]));
  return [...new Set(selected)]
    .flatMap((instanceId) => {
      const account = byId.get(instanceId);
      return account ? [account] : [];
    })
    .slice(0, MAX_RAIL_USAGE_ACCOUNTS);
}

/** Next selection after a Settings toggle; an account past the cap is ignored. */
export function toggleRailUsageAccount(
  selected: ReadonlyArray<ProviderInstanceId>,
  instanceId: ProviderInstanceId,
  enabled: boolean,
  available: ReadonlyArray<RailUsageAccount>,
): ReadonlyArray<ProviderInstanceId> {
  const current = [...new Set(selected)];
  if (!enabled) {
    return current.filter((entry) => entry !== instanceId);
  }
  if (
    current.includes(instanceId) ||
    resolveRailUsageAccounts(current, available).length >= MAX_RAIL_USAGE_ACCOUNTS
  ) {
    return current;
  }
  return [...current, instanceId];
}
