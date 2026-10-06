// FILE: AppRailUsage.logic.ts
// Purpose: Pure selection rules for the provider usage rings at the bottom of the app rail.

import type { ProviderKind } from "@synara/contracts";
import { PROVIDER_USAGE_PROVIDERS } from "@synara/shared/providerUsage";

import type { RailUsageWindow } from "~/appSettings";
import type { ProviderUsageDisplayRow } from "~/lib/providerUsageDisplay";

/** The rail is one icon wide, so only a couple of rings fit above the Help button. */
export const MAX_RAIL_USAGE_PROVIDERS = 2;

/** Stored selection → the providers actually drawn: usage-capable, unique, capped. */
export function resolveRailUsageProviders(
  selected: ReadonlyArray<ProviderKind>,
  disabledProviders: ReadonlyArray<ProviderKind> = [],
): ReadonlyArray<ProviderKind> {
  return [...new Set(selected)]
    .filter(
      (provider) =>
        PROVIDER_USAGE_PROVIDERS.includes(provider) && !disabledProviders.includes(provider),
    )
    .slice(0, MAX_RAIL_USAGE_PROVIDERS);
}

/** Next selection after a Settings toggle; a provider past the cap is ignored. */
export function toggleRailUsageProvider(
  selected: ReadonlyArray<ProviderKind>,
  provider: ProviderKind,
  enabled: boolean,
  disabledProviders: ReadonlyArray<ProviderKind> = [],
): ReadonlyArray<ProviderKind> {
  const current = resolveRailUsageProviders(selected, disabledProviders);
  const savedDisabled = [...new Set(selected)].filter(
    (entry) => PROVIDER_USAGE_PROVIDERS.includes(entry) && disabledProviders.includes(entry),
  );
  if (!enabled) {
    return [...savedDisabled, ...current.filter((entry) => entry !== provider)];
  }
  if (current.includes(provider) || current.length >= MAX_RAIL_USAGE_PROVIDERS) {
    return [...savedDisabled, ...current];
  }
  return [...savedDisabled, ...current, provider];
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
