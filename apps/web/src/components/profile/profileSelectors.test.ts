import type { ProfileTokenStats } from "@synara/contracts";
// FILE: profileSelectors.test.ts
// Purpose: Covers profile selectors that bridge fast core stats with slower
// token telemetry.
// Layer: web profile feature tests.

import { describe, expect, it } from "vitest";

import {
  selectProfileHeatmap,
  selectProfileModelUsage,
  selectProfileTokenProvenance,
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

describe("selectProfileTokenProvenance", () => {
  const baseTokenStats: ProfileTokenStats = {
    available: true,
    lifetimeTotalTokens: 100_000,
    peakDayTokens: 30_000,
    peakDay: "2026-07-02",
    providers: ["codex", "claudeAgent"] as const,
    unavailableProviders: [] as const,
    topProvider: "codex",
    topProviderPercent: 60,
    models: [],
    providerUsage: [
      {
        provider: "codex" as const,
        tokens: 60_000,
        tokensReported: true,
        tokenCoverage: "complete" as const,
        turnCount: 6,
        threadCount: 2,
        costUsd: 1.2,
        costCoverage: "complete" as const,
        lastUsedAt: "2026-07-02T09:00:00.000Z",
        models: [],
        history: [],
      },
      {
        provider: "claudeAgent" as const,
        tokens: 40_000,
        tokensReported: true,
        tokenCoverage: "partial" as const,
        turnCount: 4,
        threadCount: 1,
        costUsd: null,
        costCoverage: "not-reported" as const,
        lastUsedAt: null,
        models: [],
        history: [],
      },
    ],
    heatmapMetric: "tokens" as const,
    heatmap: [],
  };

  it("labels full token coverage as synara-measured and complete", () => {
    const result = selectProfileTokenProvenance(baseStats, {
      ...baseTokenStats,
      providerUsage: (baseTokenStats.providerUsage ?? []).map((entry) => ({
        ...entry,
        tokenCoverage: "complete" as const,
      })),
    });
    expect(result).toMatchObject({ source: "synara-measured", coverage: "complete" });
  });

  it("labels mixed coverage as partial and counts the providers honestly", () => {
    const result = selectProfileTokenProvenance(baseStats, baseTokenStats);
    expect(result).toMatchObject({
      source: "synara-measured",
      coverage: "partial",
      providersWithTokens: 2,
      providersWithTurns: 2,
    });
  });

  it("marks measured totals partial when another active provider has no telemetry", () => {
    const providerUsage = (baseTokenStats.providerUsage ?? []).map((entry, index) => ({
      ...entry,
      tokens: index === 0 ? 60000 : 0,
      tokensReported: index === 0,
      tokenCoverage: index === 0 ? ("complete" as const) : ("not-reported" as const),
    }));
    expect(
      selectProfileTokenProvenance(baseStats, { ...baseTokenStats, providerUsage }),
    ).toMatchObject({
      coverage: "partial",
      providersWithTokens: 1,
      providersWithTurns: 2,
    });
  });

  it("returns none when token stats are unavailable", () => {
    const result = selectProfileTokenProvenance(baseStats, null);
    expect(result).toMatchObject({ source: "none", coverage: "none" });
  });

  it("returns not-reported when turns exist but no token telemetry", () => {
    const result = selectProfileTokenProvenance(baseStats, {
      ...baseTokenStats,
      lifetimeTotalTokens: null,
      providerUsage: (baseTokenStats.providerUsage ?? []).map((entry) => ({
        ...entry,
        tokens: 0,
        tokensReported: false,
        tokenCoverage: "not-reported" as const,
      })),
    });
    expect(result).toMatchObject({ source: "synara-measured", coverage: "not-reported" });
  });
});
