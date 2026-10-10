// FILE: profileSelectors.test.ts
// Purpose: Covers profile selectors that bridge fast core stats with slower
// token telemetry.
// Layer: web profile feature tests.

import { describe, expect, it } from "vitest";

import {
  selectProfileHeatmap,
  selectProfileModelUsage,
  selectProfileTopProvider,
} from "./profileSelectors";

import { baseStats, tokenStats, promptHeatmapCell, tokenHeatmapCell } from "./profileTestFixtures";

describe("profile selectors", () => {
  it("prefers token telemetry once available", () => {
    expect(selectProfileTopProvider(baseStats, tokenStats)).toEqual({
      provider: "claudeAgent",
      percent: 83.3,
      metric: "tokens",
      unavailableProviders: [],
    });
    expect(selectProfileHeatmap(baseStats, tokenStats)).toEqual({
      cells: [tokenHeatmapCell],
      unit: "tokens",
    });
    expect(selectProfileModelUsage(baseStats, tokenStats)).toEqual({
      entries: tokenStats.models,
      metric: "tokens",
      unavailableProviders: [],
    });
  });

  it("falls back to core profile stats while token telemetry is unavailable", () => {
    expect(selectProfileTopProvider(baseStats, null)).toEqual({
      provider: "codex",
      percent: 66.7,
      metric: "turns",
      unavailableProviders: [],
    });
    expect(selectProfileHeatmap(baseStats, null)).toEqual({
      cells: [promptHeatmapCell],
      unit: "prompts",
    });
    expect(selectProfileModelUsage(baseStats, null)).toEqual({
      entries: baseStats.providerModels,
      metric: "turns",
      unavailableProviders: [],
    });
  });

  it("falls back to turn-based model usage when token telemetry has no model rows", () => {
    expect(selectProfileModelUsage(baseStats, { ...tokenStats, models: [] })).toEqual({
      entries: baseStats.providerModels,
      metric: "turns",
      unavailableProviders: [],
    });
  });
});
