// FILE: profileHeatmap.ts
// Purpose: Single source for which per-day activity series profile surfaces render.
// The heatmap prefers tokens/day (one heavy prompt can burn far more tokens than many
// small ones) and falls back to prompts/day when no token totals exist yet. Shared by
// the Settings → Profile panel and the exported share card so both stay in sync.
// Layer: web profile feature (pure selection logic, no I/O).

import type { ProfileHeatmapCell, ProfileStats, ProfileTokenStats } from "@synara/contracts";

export interface ProfileHeatmapSelection {
  readonly cells: ReadonlyArray<ProfileHeatmapCell>;
  /** Tooltip noun matching the selected series ("tokens" or "prompts"). */
  readonly unit: "tokens" | "prompts";
}

export function selectProfileHeatmap(
  stats: ProfileStats,
  tokenStats: ProfileTokenStats | null,
): ProfileHeatmapSelection {
  if (tokenStats?.available) {
    return { cells: tokenStats.heatmap, unit: "tokens" };
  }
  return { cells: stats.activity.heatmap, unit: "prompts" };
}
