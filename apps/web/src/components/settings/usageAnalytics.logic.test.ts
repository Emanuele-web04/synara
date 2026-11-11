import type { StatsGetUsageAnalyticsResult } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildUsageAnalyticsView,
  localDayKey,
  percentChange,
  usageAnalyticsWindow,
} from "./usageAnalytics.logic";

/** An instant `hours` after local midnight of `day` (YYYY-MM-DD), as the server's UTC hour. */
function localHour(day: string, hours: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year!, month! - 1, date!, hours).toISOString();
}

const NOW = new Date(2026, 10, 11, 15);
const window = usageAnalyticsWindow("7d", NOW);
const today = localDayKey(NOW);
const firstDay = localDayKey(window.from);
const dayBefore = localDayKey(new Date(window.from.getTime() - 12 * 3_600_000));

const result: StatsGetUsageAnalyticsResult = {
  generatedAt: NOW.toISOString(),
  from: window.previousFrom!.toISOString(),
  to: window.to.toISOString(),
  tokens: [
    {
      hour: localHour(today, 9),
      provider: "claudeAgent",
      model: "claude-opus",
      projectId: "p-app",
      origin: "user",
      tokens: 3000,
      cacheReadTokens: 2000,
    },
    {
      hour: localHour(firstDay, 22),
      provider: "codex",
      model: "gpt-codex",
      projectId: null,
      origin: "agent",
      tokens: 1000,
      cacheReadTokens: 0,
    },
    {
      hour: localHour(dayBefore, 10),
      provider: "codex",
      model: "gpt-codex",
      projectId: null,
      origin: "user",
      tokens: 2000,
      cacheReadTokens: 0,
    },
  ],
  turns: [
    {
      hour: localHour(today, 9),
      provider: "claudeAgent",
      model: "claude-opus",
      projectId: "p-app",
      turns: 2,
      failedTurns: 1,
    },
  ],
  costs: [
    {
      hour: localHour(today, 9),
      provider: "claudeAgent",
      model: "claude-opus",
      projectId: "p-app",
      source: "reported",
      costUsd: 1.25,
      turns: 2,
    },
    {
      hour: localHour(firstDay, 22),
      provider: "codex",
      model: "gpt-codex",
      projectId: null,
      source: "estimated",
      costUsd: 0.5,
      turns: 0,
    },
  ],
  pricing: { status: "fresh", fetchedAt: null, unpricedModels: [], unpricedTokens: 0 },
  projects: [{ projectId: "p-app", title: "App" }],
  unavailableProviders: ["cursor"],
};

describe("usageAnalyticsWindow", () => {
  it("covers whole local days ending today, with the period before when it fits", () => {
    expect(window.days).toHaveLength(7);
    expect(localDayKey(window.days.at(-1)!)).toBe(today);
    expect(window.previousFrom).not.toBeNull();
    expect(usageAnalyticsWindow("1y", NOW).previousFrom).toBeNull();
  });
});

describe("buildUsageAnalyticsView", () => {
  const view = buildUsageAnalyticsView(result, window);

  it("buckets rows into local days and keeps the previous period apart", () => {
    expect(view.totals).toMatchObject({
      tokens: 4000,
      cacheReadTokens: 2000,
      turns: 2,
      failedTurns: 1,
    });
    expect(view.totals.costUsd).toBeCloseTo(1.75);
    expect(view.previous?.tokens).toBe(2000);
    expect(view.days.at(-1)).toMatchObject({ tokens: 3000 });
    expect(view.days[0]?.byProvider.codex?.tokens).toBe(1000);
    expect(view.activeDays).toBe(2);
  });

  it("ranks providers, models and projects, with chats outside projects grouped", () => {
    expect(view.providers.map((provider) => provider.provider)).toEqual(["claudeAgent", "codex"]);
    expect(view.providers[0]?.costSource).toBe("reported");
    expect(view.providers[1]?.costSource).toBe("estimated");
    expect(view.models[0]).toMatchObject({ model: "claude-opus", turns: 2 });
    expect(view.projects).toEqual([
      expect.objectContaining({ projectId: "p-app", title: "App", tokens: 3000 }),
      expect.objectContaining({ projectId: null, title: "Chats", tokens: 1000 }),
    ]);
    expect(view.origins).toEqual({ user: 3000, automation: 0, agent: 1000 });
    expect(view.unavailableProviders).toEqual(["cursor"]);
  });

  it("places tokens on the local weekday and hour", () => {
    const weekday = (NOW.getDay() + 6) % 7;
    expect(view.rhythm[weekday]?.[9]).toBe(3000);
  });
});

describe("percentChange", () => {
  it("needs a positive base", () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(5, 0)).toBeNull();
    expect(percentChange(5, null)).toBeNull();
  });
});
