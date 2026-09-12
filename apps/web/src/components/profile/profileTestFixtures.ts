// Shared profile regression fixtures.
import type { ProfileStats, ProfileTokenStats } from "@synara/contracts";

export const promptHeatmapCell = {
  day: "2026-07-01",
  count: 3,
  weekday: 3,
  intensity: 2,
};

export const tokenHeatmapCell = {
  day: "2026-07-02",
  count: 6000,
  weekday: 4,
  intensity: 4,
};

export const baseStats = {
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
    heatmap: [promptHeatmapCell],
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
  providerModels: [
    { provider: "codex", model: "gpt-5-codex", turnCount: 2, percent: 66.7 },
    { provider: "claudeAgent", model: "claude-sonnet-4-6", turnCount: 1, percent: 33.3 },
  ],
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

export const tokenStats = {
  available: true,
  lifetimeTotalTokens: 6000,
  peakDayTokens: 5000,
  peakDay: "2026-07-02",
  providers: ["claudeAgent", "codex"],
  unavailableProviders: [],
  topProvider: "claudeAgent",
  topProviderPercent: 83.3,
  models: [
    { provider: "claudeAgent", model: "claude-sonnet-4-6", tokens: 5000, percent: 83.3 },
    { provider: "codex", model: "gpt-5-codex", tokens: 1000, percent: 16.7 },
  ],
  heatmapMetric: "tokens",
  heatmap: [tokenHeatmapCell],
} satisfies ProfileTokenStats;
