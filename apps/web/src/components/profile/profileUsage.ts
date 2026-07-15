// FILE: profileUsage.ts
// Purpose: Shared selectors for profile usage insights that combine fast core stats
// with slower token telemetry once it arrives.
// Layer: web profile feature (pure selection logic, no I/O).

import type { ProfileStats, ProfileTokenStats, ProviderKind } from "@synara/contracts";

export interface ProfileTopProviderSelection {
  readonly provider: ProviderKind | null;
  readonly percent: number | null;
  readonly metric: "tokens" | "turns";
}

// Prefer token-based provider usage when telemetry is available; fall back to
// turn count while the slower token query is pending or unavailable.
export function selectProfileTopProvider(
  stats: ProfileStats,
  tokenStats: ProfileTokenStats | null,
): ProfileTopProviderSelection {
  if (tokenStats?.available && tokenStats.topProvider) {
    return {
      provider: tokenStats.topProvider,
      percent: tokenStats.topProviderPercent,
      metric: "tokens",
    };
  }

  return {
    provider: stats.insights.topProvider,
    percent: stats.insights.topProviderPercent,
    metric: "turns",
  };
}
