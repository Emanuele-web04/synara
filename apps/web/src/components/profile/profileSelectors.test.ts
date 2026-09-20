// FILE: profileSelectors.test.ts
// Purpose: Covers profile selectors that bridge fast core stats with slower
// token telemetry.
// Layer: web profile feature tests.

import type { ProfileStats, ProfileTokenStats } from "@synara/contracts";
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

  // #1007: a provider with real turns (Grok) that never emits token telemetry
  // must not silently disappear from the ranking once any other provider has
  // token stats — callers need the list to disclose it instead.
  it("surfaces providers with turns but no token telemetry instead of dropping them", () => {
    const grokStats = {
      ...baseStats,
      insights: { ...baseStats.insights, topProvider: "grok", topProviderPercent: 100 },
      providerModels: [
        ...baseStats.providerModels,
        { provider: "grok", model: "grok-4.6", turnCount: 3, percent: 50 },
      ],
    } satisfies ProfileStats;
    const tokenStatsMissingGrok = {
      ...tokenStats,
      unavailableProviders: ["grok"],
    } satisfies ProfileTokenStats;

    const topProvider = selectProfileTopProvider(grokStats, tokenStatsMissingGrok);
    expect(topProvider.metric).toBe("tokens");
    expect(topProvider.unavailableProviders).toEqual(["grok"]);

    const modelUsage = selectProfileModelUsage(grokStats, tokenStatsMissingGrok);
    expect(modelUsage.metric).toBe("tokens");
    expect(modelUsage.unavailableProviders).toEqual(["grok"]);
  });

  it("reports no unavailable providers once telemetry fully falls back to turns", () => {
    // available: false forces the turns-based branch; that branch's providers
    // are all represented by definition, so the stale unavailableProviders
    // list from a not-yet-available token payload must not leak through.
    const notAvailable = {
      ...tokenStats,
      available: false,
      unavailableProviders: ["grok"],
    } satisfies ProfileTokenStats;
    expect(selectProfileTopProvider(baseStats, notAvailable).unavailableProviders).toEqual([]);
    expect(selectProfileModelUsage(baseStats, notAvailable).unavailableProviders).toEqual([]);
  });
});
