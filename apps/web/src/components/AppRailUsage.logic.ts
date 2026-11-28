// FILE: AppRailUsage.logic.ts
// Purpose: Pure selection rules for the provider usage rings at the bottom of the app rail.

import { t } from "~/i18n";
import type {
  ProviderInstanceId,
  ProviderKind,
  ServerProviderUsageSnapshot,
  ServerUsageHub,
} from "@synara/contracts";
import type { ResolvedProviderInstance } from "@synara/shared/providerInstances";
import { PROVIDER_USAGE_PROVIDERS, providerUsageDisplayName } from "@synara/shared/providerUsage";

import type { RailUsageWindow } from "~/appSettings";
import { providerAccountQualifiedLabel } from "~/lib/providerInstancePresentation";
import type { ProviderUsageDisplayRow } from "~/lib/providerUsageDisplay";
import { USAGE_HUB_ACCOUNT_KEY_PREFIX, flattenUsageHubAccounts } from "~/lib/usageHubs";

/** The rail is one icon wide, so only a couple of rings fit above the Help button. */
export const MAX_RAIL_USAGE_ACCOUNTS = 2;

export interface RailUsageAccount {
  /** Provider instance id, or a usage hub account's key; both live in `railUsageInstanceIds`. */
  readonly id: ProviderInstanceId;
  readonly driver: ResolvedProviderInstance["driver"];
  readonly label: string;
  readonly dotted: boolean;
  readonly accentColor: string | undefined;
  /** Hub accounts carry their own snapshot; local accounts read the provider usage batch. */
  readonly hubSnapshot?: ServerProviderUsageSnapshot;
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
        id: instance.instanceId,
        driver: instance.driver,
        accentColor: instance.raw.accentColor,
        dotted: accounts.length > 1 && !instance.isDefault,
        label: showAccountName
          ? providerAccountQualifiedLabel(providerName, accountName)
          : providerName,
      };
    });
  });
}

/** Accounts pooled on usage hubs, after the local ones in Settings and on the rail. */
export function getRailUsageHubAccounts(
  hubs: ReadonlyArray<ServerUsageHub> | undefined,
  disabledProviders: ReadonlyArray<ProviderKind> = [],
): ReadonlyArray<RailUsageAccount> {
  return flattenUsageHubAccounts(hubs).flatMap(({ account, name }) => {
    const driver = account.usage.provider;
    if (disabledProviders.includes(driver)) return [];
    return [
      {
        id: account.key,
        driver,
        // Always lead with the provider: hub file names (`claude-1.json`) already contain it,
        // which would make the shared qualifier drop it.
        label: `${providerUsageDisplayName(driver)} · ${name}`,
        dotted: false,
        accentColor: undefined,
        hubSnapshot: account.usage,
      },
    ];
  });
}

/**
 * Saved rail ids worth keeping when Settings writes the selection back. Disabled accounts
 * keep their choice; only deleted ones are dropped. A hub account counts as deleted only
 * once every hub has been read cleanly without it: an unreachable hub lists no accounts.
 */
export function retainSavedRailUsageIds(
  saved: ReadonlyArray<ProviderInstanceId>,
  localInstanceIds: ReadonlySet<ProviderInstanceId>,
  hubs: ReadonlyArray<ServerUsageHub> | undefined,
): ReadonlyArray<ProviderInstanceId> {
  const hubIds = new Set(getRailUsageHubAccounts(hubs).map((account) => account.id));
  const hubAccountsKnown = hubs !== undefined && hubs.every((hub) => !hub.error);
  return saved.filter(
    (id) =>
      localInstanceIds.has(id) ||
      hubIds.has(id) ||
      (id.startsWith(USAGE_HUB_ACCOUNT_KEY_PREFIX) && !hubAccountsKnown),
  );
}

/** Stored selection → unique available accounts, capped after dropping stale ids. */
export function resolveRailUsageAccounts(
  selected: ReadonlyArray<ProviderInstanceId>,
  available: ReadonlyArray<RailUsageAccount>,
): ReadonlyArray<RailUsageAccount> {
  const byId = new Map(available.map((account) => [account.id, account]));
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

/**
 * The rows a rail ring draws, outermost first. Named model/pool sublimits can share the
 * account windows' durations, so the account rows are picked by label. A provider that does
 * not report the chosen window shows its other account window, and one with neither keeps
 * its most constrained row, so a chosen provider never loses its ring.
 */
export function selectRailUsageRows(
  rows: ReadonlyArray<ProviderUsageDisplayRow>,
  primaryRow: ProviderUsageDisplayRow | null,
  window: RailUsageWindow,
): ReadonlyArray<ProviderUsageDisplayRow> {
  const weekly = rows.find((row) => row.label === "Weekly");
  const fiveHour = rows.find((row) => row.label === "5h");
  const preferred =
    window === "both"
      ? [weekly, fiveHour]
      : window === "weekly"
        ? [weekly ?? fiveHour]
        : [fiveHour ?? weekly];
  const selected = preferred.filter((row) => row !== undefined);
  if (selected.length > 0) {
    return selected;
  }
  return primaryRow ? [primaryRow] : [];
}

export type RailUsageRingTone = "healthy" | "fair" | "low" | "critical";

/** Remaining quota → ring colour step; the last two match the usage bars' warning/danger. */
export function railUsageRingTone(remainingPercent: number): RailUsageRingTone {
  if (remainingPercent <= 10) return "critical";
  if (remainingPercent <= 25) return "low";
  if (remainingPercent <= 50) return "fair";
  return "healthy";
}
