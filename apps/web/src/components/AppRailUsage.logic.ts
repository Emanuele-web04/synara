// FILE: AppRailUsage.logic.ts
// Purpose: Pure selection rules for the provider usage rings at the bottom of the app rail.

import type { ProviderKind } from "@synara/contracts";
import { PROVIDER_USAGE_PROVIDERS } from "@synara/shared/providerUsage";

/** The rail is one icon wide, so only a couple of rings fit above the Help button. */
export const MAX_RAIL_USAGE_PROVIDERS = 2;

/** Stored selection → the providers actually drawn: usage-capable, unique, capped. */
export function resolveRailUsageProviders(
  selected: ReadonlyArray<ProviderKind>,
): ReadonlyArray<ProviderKind> {
  return [...new Set(selected)]
    .filter((provider) => PROVIDER_USAGE_PROVIDERS.includes(provider))
    .slice(0, MAX_RAIL_USAGE_PROVIDERS);
}

/** Next selection after a Settings toggle; a provider past the cap is ignored. */
export function toggleRailUsageProvider(
  selected: ReadonlyArray<ProviderKind>,
  provider: ProviderKind,
  enabled: boolean,
): ReadonlyArray<ProviderKind> {
  const current = resolveRailUsageProviders(selected);
  if (!enabled) {
    return current.filter((entry) => entry !== provider);
  }
  if (current.includes(provider) || current.length >= MAX_RAIL_USAGE_PROVIDERS) {
    return current;
  }
  return [...current, provider];
}
