import { describe, expect, it } from "vitest";
import { activeDayCount, buildDailySeries, tokensInYear } from "./dailySeries";
import { buildCalendarYearCells, buildHeatmapCells, weeklyTotals } from "./heatmapCells";
import { groupModelUsage } from "./modelUsage";
import { formatStreakShort, joinedAgo } from "./profileFormat";
import { isShareFormat, linePath, posterSentence, shareCardData } from "./shareCards";
import { isDrawableAvatarType } from "./imageAvatar";
import { parseFontFaces } from "./imageFonts";
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
      {
        provider: "claudeAgent",
        model: "claude-haiku-4-5-20251001",
        reasoning: null,
        tokens: 5,
        turns: 1,
        prompts: 1,
      },
      {
        provider: "claudeAgent",
        model: "claude-haiku-4-5",
        reasoning: null,
        tokens: 4,
        turns: 1,
        prompts: 1,
      },
    ]);
    expect(groups.map((group) => group.displayName)).toEqual([
      "GPT-6 Astra",
      "Claude Sonnet 5.5",
      "Claude Haiku 4.5",
    ]);
    expect(groups[2]).toMatchObject({ tokens: 9, turns: 2 });
    expect(groups[0]).toMatchObject({ tokens: 670, turns: 7, reasoning: ["low", "high"] });
  });
});

describe("calendar-year activity", () => {
  it.each([
    [2026, 365],
    [2024, 366],
  ])("shows all of %i and leaves future days empty", (year, length) => {
    const cells = buildCalendarYearCells(
      [
        { day: `${year - 1}-12-31`, tokens: 900, prompts: 1 },
        { day: `${year}-01-01`, tokens: 10, prompts: 1 },
        { day: `${year}-10-08`, tokens: 20, prompts: 1 },
        { day: `${year}-12-31`, tokens: 800, prompts: 1 },
      ],
      `${year}-10-08`,
    );
    expect(cells).toHaveLength(length);
    expect(cells[0]).toMatchObject({ day: `${year}-01-01`, count: 10 });
    expect(cells.at(-1)).toMatchObject({ day: `${year}-12-31`, count: 0, intensity: 0 });
    expect(cells.reduce((sum, cell) => sum + cell.count, 0)).toBe(30);
  });
});

describe("weeklyTotals", () => {
  it("folds the window into Sunday-first weeks, a partial first week included", () => {
    const cells = buildHeatmapCells(
      [
        { day: "2026-09-29", tokens: 10, prompts: 1 },
        { day: "2026-10-04", tokens: 5, prompts: 1 },
        { day: "2026-10-07", tokens: 7, prompts: 1 },
      ],
      "2026-10-07",
      10,
    );
    expect(weeklyTotals(cells)).toEqual([
      { start: "2026-09-27", tokens: 10 },
      { start: "2026-10-04", tokens: 12 },
    ]);
  });
});

describe("joinedAgo", () => {
  it("counts whole days to the owner's today", () => {
    expect(joinedAgo("2026-09-07T22:10:00Z", "2026-10-07")).toBe("Joined 30 days ago");
    expect(joinedAgo("2026-10-06T08:00:00Z", "2026-10-07")).toBe("Joined yesterday");
    expect(joinedAgo("2026-10-07T08:00:00Z", "2026-10-07")).toBe("Joined today");
    expect(joinedAgo("not a date", "2026-10-07")).toBeNull();
  });

  it("writes streaks compactly", () => {
    expect(formatStreakShort(0)).toBe("—");
    expect(formatStreakShort(199)).toBe("199d");
  });
});

describe("share cards", () => {
  const profile = {
    handle: "ada",
    displayName: "Ada",
    avatarColor: "#123456",
    themeAccent: { light: "#ff6600", dark: "#ff8833" },
    createdAt: "2026-09-01T00:00:00Z",
    lifetimeTokens: 869_231,
    lifetimePrompts: 33,
    lifetimeTurns: 35,
    models: [
      {
        provider: "codex",
        model: "gpt-6-astra",
        reasoning: "low",
        tokens: 700_000,
        turns: 27,
        prompts: 27,
      },
      {
        provider: "claudeAgent",
        model: "claude-sonnet-5-5",
        reasoning: null,
        tokens: 169_231,
        turns: 8,
        prompts: 6,
      },
    ],
    heatmap: [
      { day: "2026-10-06", tokens: 300_000, prompts: 10 },
      { day: "2026-10-07", tokens: 569_231, prompts: 23 },
    ],
    localToday: "2026-10-07",
    peakDay: { day: "2026-10-07", tokens: 569_231 },
    hours: [
      { hour: 9, prompts: 3 },
      { hour: 15, prompts: 6 },
    ],
    currentStreakDays: 2,
    longestStreakDays: 2,
  };

  it("summarizes the profile for the poster and the receipt", () => {
    const data = shareCardData(profile);
    expect(data).toMatchObject({
      accent: "#ff6600",
      totalTokensExact: "869,231",
      activeDays: 2,
      topModel: "GPT-6 Astra",
      busiestHour: "3 PM",
    });
    expect(data.month).toHaveLength(30);
    expect(data.month.slice(-2).map((point) => point.tokens)).toEqual([300_000, 569_231]);
    expect(data.models.map((model) => model.name)).toEqual(["GPT-6 Astra", "Claude Sonnet 5.5"]);
    expect(posterSentence(data)).toBe(
      "33 prompts over 2 days, mostly with GPT-6 Astra, usually around 3 PM.",
    );
  });

  it("knows its formats and draws a line through the month", () => {
    expect(isShareFormat("story")).toBe(true);
    expect(isShareFormat("receipt")).toBe(false);
    expect(linePath([0, 10], 100, 50)).toBe("M0.0,50.0 L100.0,4.0");
  });
});

describe("isDrawableAvatarType", () => {
  it("accepts what next/og decodes and nothing else", () => {
    expect(isDrawableAvatarType("image/jpeg")).toBe(true);
    expect(isDrawableAvatarType("image/png; charset=binary")).toBe(true);
    expect(isDrawableAvatarType("image/webp")).toBe(false);
    expect(isDrawableAvatarType(null)).toBe(false);
  });
});

describe("parseFontFaces", () => {
  it("pairs each weight with its TTF source", () => {
    const css = `/* latin */
@font-face {
  font-family: 'JetBrains Mono';
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/jetbrainsmono/v24/a.ttf) format('truetype');
}
@font-face {
  font-family: 'JetBrains Mono';
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/jetbrainsmono/v24/b.ttf) format('truetype');
}
@font-face { font-weight: 400; src: url(https://evil.example/x.ttf); }`;
    expect(parseFontFaces(css)).toEqual([
      { weight: 400, url: "https://fonts.gstatic.com/s/jetbrainsmono/v24/a.ttf" },
      { weight: 700, url: "https://fonts.gstatic.com/s/jetbrainsmono/v24/b.ttf" },
    ]);
  });
});
