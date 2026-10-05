// FILE: AppRailUsage.logic.ts
// Purpose: Pure selection rules for the provider usage rings at the bottom of the app rail.

import type { ProviderInstanceId } from "@synara/contracts";
import type { ResolvedProviderInstance } from "@synara/shared/providerInstances";
import { PROVIDER_USAGE_PROVIDERS, providerUsageDisplayName } from "@synara/shared/providerUsage";

import type { RailUsageWindow } from "~/appSettings";
import { providerAccountQualifiedLabel } from "~/lib/providerInstancePresentation";
import type { ProviderUsageDisplayRow } from "~/lib/providerUsageDisplay";

/** The rail is one icon wide, so only a couple of rings fit above the Help button. */
export const MAX_RAIL_USAGE_ACCOUNTS = 2;

export interface RailUsageAccount {
  readonly instance: ResolvedProviderInstance;
  readonly label: string;
  readonly dotted: boolean;
}

/** Enabled usage-capable accounts, named consistently in Settings and the rail. */
export function getRailUsageAccounts(
  instances: ReadonlyArray<ResolvedProviderInstance>,
): ReadonlyArray<RailUsageAccount> {
  return PROVIDER_USAGE_PROVIDERS.flatMap((provider) => {
    const accounts = instances.filter(
      (instance) => instance.enabled && instance.driver === provider,
    );
    const providerName = providerUsageDisplayName(provider);
    return accounts.map((instance) => {
      const showAccountName =
        !instance.isDefault || accounts.length > 1 || Boolean(instance.raw.displayName?.trim());
      const accountName =
        instance.isDefault && !instance.raw.displayName?.trim()
          ? "Default account"
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
): ReadonlyArray<ProviderInstanceId> {
  const current = [...new Set(selected)].slice(0, MAX_RAIL_USAGE_ACCOUNTS);
  if (!enabled) {
    return current.filter((entry) => entry !== instanceId);
  }
  if (current.includes(instanceId) || current.length >= MAX_RAIL_USAGE_ACCOUNTS) {
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
