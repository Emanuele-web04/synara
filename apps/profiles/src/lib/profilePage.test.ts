import { describe, expect, it } from "vitest";
import { activeDayCount, buildDailySeries, tokensInYear } from "./dailySeries";
import { groupModelUsage } from "./modelUsage";
import { profileAccentStyle, resolveProfileAccent } from "./profileAccent";

describe("resolveProfileAccent", () => {
  it("prefers the owner's theme accent per appearance", () => {
    expect(
      resolveProfileAccent({
        avatarColor: "#123456",
        themeAccent: { light: "#ff6600", dark: "#ff8833" },
      }),
    ).toEqual({ light: "#ff6600", dark: "#ff8833" });
  });

  it("falls back to the avatar color, then to the page default", () => {
    expect(resolveProfileAccent({ avatarColor: "#123456", themeAccent: null })).toEqual({
      light: "#123456",
      dark: "#123456",
    });
    expect(resolveProfileAccent({ avatarColor: "blue" })).toBeNull();
    expect(profileAccentStyle(null)).toEqual({});
  });

  it("ignores a malformed theme accent", () => {
    expect(
      resolveProfileAccent({
        avatarColor: "#123456",
        themeAccent: { light: "red", dark: "#ff8833" },
      }),
    ).toEqual({ light: "#123456", dark: "#123456" });
  });
});

describe("buildDailySeries", () => {
  const days = [
    { day: "2026-10-05", tokens: 100, prompts: 2 },
    { day: "2026-10-07", tokens: 300, prompts: 5 },
    { day: "2025-12-31", tokens: 9, prompts: 1 },
  ];

  it("zero-fills the trailing window ending on the owner's today", () => {
    const series = buildDailySeries(days, 4, "2026-10-07");
    expect(series.map((point) => point.day)).toEqual([
      "2026-10-04",
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
    ]);
    expect(series.map((point) => point.tokens)).toEqual([0, 100, 0, 300]);
    expect(activeDayCount(series)).toBe(2);
  });

  it("sums a calendar year", () => {
    expect(tokensInYear(days, "2026")).toBe(400);
    expect(tokensInYear(days, "2025")).toBe(9);
  });
});

describe("groupModelUsage", () => {
  it("merges reasoning levels into one named model, most used first", () => {
    const groups = groupModelUsage([
      {
        provider: "codex",
        model: "gpt-6-astra",
        reasoning: "low",
        tokens: 400,
        turns: 4,
        prompts: 4,
      },
      {
        provider: "codex",
        model: "gpt-6-astra",
        reasoning: null,
        tokens: 200,
        turns: 2,
        prompts: 2,
      },
      {
        provider: "codex",
        model: "gpt-6-astra",
        reasoning: "high",
        tokens: 70,
        turns: 1,
        prompts: 1,
      },
      {
        provider: "claudeAgent",
        model: "claude-sonnet-5-5",
        reasoning: null,
        tokens: 120,
        turns: 3,
        prompts: 3,
      },
    ]);
    expect(groups.map((group) => group.displayName)).toEqual(["GPT-6 Astra", "Claude Sonnet 5.5"]);
    expect(groups[0]).toMatchObject({ tokens: 670, turns: 7, reasoning: ["low", "high"] });
  });
});
