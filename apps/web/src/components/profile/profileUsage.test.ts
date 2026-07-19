// FILE: profileUsage.test.ts
// Purpose: Covers the profile usage selectors that bridge fast core stats with
// slower token telemetry.
// Layer: web profile feature tests.

import type { ProfileStats, ProfileTokenStats } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { selectProfileTopProvider } from "./profileUsage";

const baseStats = {
  generatedAt: "2026-07-02T10:00:00.000Z",
  timezone: { utcOffsetMinutes: 0, today: "2026-07-02" },
  identity: { homeDirBasename: "synara", initials: "S", defaultHandle: "@synara" },
  activity: {
    currentStreakDays: 0,
    longestStreakDays: 0,
    totalPromptsSent: 0,
    totalThreads: 0,
    promptsToday: 0,
    heatmapMetric: "prompts",
    heatmap: [],
  },
  activeHours: { startHour: null, endHour: null, turnCount: 0, label: null },
  insights: {
    topProvider: "codex",
    topProviderPercent: 66.7,
    topReasoning: null,
    topReasoningPercent: null,
    skillsExplored: 0,
    totalSkillsUsed: 0,
  },
  providerModels: [],
  skills: [],
  mostUsedSkill: null,
  mostWorkedProject: null,
  quota: {
    status: "unavailable",
    provider: null,
    window: null,
    usedPercent: null,
    resetsAt: null,
    planName: null,
  },
} satisfies ProfileStats;

const tokenStats = {
  available: true,
  lifetimeTotalTokens: 6000,
  peakDayTokens: 5000,
  peakDay: "2026-07-02",
  providers: ["claudeAgent", "codex"],
  unavailableProviders: [],
  topProvider: "claudeAgent",
  topProviderPercent: 83.3,
  heatmapMetric: "tokens",
  heatmap: [],
  models: [],
} satisfies ProfileTokenStats;

describe("selectProfileTopProvider", () => {
  it("prefers token telemetry once available", () => {
    expect(selectProfileTopProvider(baseStats, tokenStats)).toEqual({
      provider: "claudeAgent",
      percent: 83.3,
      metric: "tokens",
    });
  });

  it("falls back to turn-count insights while token telemetry is unavailable", () => {
    expect(selectProfileTopProvider(baseStats, null)).toEqual({
      provider: "codex",
      percent: 66.7,
      metric: "turns",
    });
  });
});
