// FILE: rateLimits.test.ts
// Purpose: Locks the window-identity rules: model aliases resolve before the shared weekly
// duration, unmapped provider labels keep their identity, durations come from one registry,
// and visible rows sort deterministically.

import { describe, expect, it } from "vitest";

import {
  deriveVisibleRateLimitRows,
  formatRateLimitDisplayLabel,
  normalizeRateLimitLabel,
  windowDurationMinsForWindowLabel,
} from "./rateLimits";

describe("normalizeRateLimitLabel", () => {
  it("resolves model aliases before the shared weekly duration", () => {
    expect(normalizeRateLimitLabel("Fable", 10080)).toBe("Fable");
    expect(normalizeRateLimitLabel("seven_day_fable", 10080)).toBe("Fable");
    expect(normalizeRateLimitLabel("weekly_sonnet", 10080)).toBe("Sonnet");
    expect(normalizeRateLimitLabel("seven_day_opus", 10080)).toBe("Opus");
  });

  it("keeps unmapped provider labels as their trimmed identity", () => {
    expect(normalizeRateLimitLabel("Opus 4.5", 10080)).toBe("Opus 4.5");
    expect(normalizeRateLimitLabel("  Plus  ", 300)).toBe("Plus");
    expect(normalizeRateLimitLabel("Monthly", 43200)).toBe("Monthly");
    expect(normalizeRateLimitLabel("monthly", 43200)).toBe("monthly");
  });

  it("maps generic keys through the duration first, then the canonical name", () => {
    expect(normalizeRateLimitLabel("Session", 300)).toBe("5h");
    expect(normalizeRateLimitLabel("Weekly", 300)).toBe("5h");
    expect(normalizeRateLimitLabel("seven_day", 10080)).toBe("Weekly");
    expect(normalizeRateLimitLabel("weekly", 10080)).toBe("Weekly");
    expect(normalizeRateLimitLabel("Daily", 1440)).toBe("Daily");
    expect(normalizeRateLimitLabel("seven_day_fable", 300)).toBe("Fable");
    expect(normalizeRateLimitLabel(undefined, 1440)).toBe("Current");
    expect(normalizeRateLimitLabel("", 300)).toBe("5h");
  });

  it("keeps the included overage window independent and paid overage as usage credits", () => {
    expect(normalizeRateLimitLabel("seven_day_overage_included", 10080)).toBe("Weekly (overage)");
    expect(normalizeRateLimitLabel("Weekly (overage)", 10080)).toBe("Weekly (overage)");
    expect(normalizeRateLimitLabel("overage", 10080)).toBe("Usage credits");
    expect(normalizeRateLimitLabel("usage_credits", 10080)).toBe("Usage credits");
  });

  it("is idempotent for canonical identities", () => {
    expect(normalizeRateLimitLabel(normalizeRateLimitLabel("Fable", 10080), 10080)).toBe("Fable");
    expect(normalizeRateLimitLabel(normalizeRateLimitLabel("Opus 4.5", 10080), 10080)).toBe(
      "Opus 4.5",
    );
    expect(
      normalizeRateLimitLabel(normalizeRateLimitLabel("seven_day_overage_included", 10080), 10080),
    ).toBe("Weekly (overage)");
  });
});

describe("windowDurationMinsForWindowLabel", () => {
  it("shares the weekly duration across model identities", () => {
    expect(windowDurationMinsForWindowLabel("5h")).toBe(300);
    expect(windowDurationMinsForWindowLabel("Weekly")).toBe(10080);
    expect(windowDurationMinsForWindowLabel("Fable")).toBe(10080);
    expect(windowDurationMinsForWindowLabel("Sonnet")).toBe(10080);
    expect(windowDurationMinsForWindowLabel("Opus")).toBe(10080);
    expect(windowDurationMinsForWindowLabel("Weekly (overage)")).toBe(10080);
  });

  it("has no default duration for credits or unmapped labels", () => {
    expect(windowDurationMinsForWindowLabel("Usage credits")).toBeUndefined();
    expect(windowDurationMinsForWindowLabel("Monthly")).toBeUndefined();
    expect(windowDurationMinsForWindowLabel(undefined)).toBeUndefined();
  });
});

describe("formatRateLimitDisplayLabel", () => {
  it("humanizes machine snake_case keys only", () => {
    expect(formatRateLimitDisplayLabel("a_b")).toBe("A B");
    expect(formatRateLimitDisplayLabel("opus_4_5")).toBe("Opus 4 5");
  });

  it("leaves model and canonical labels untouched", () => {
    expect(formatRateLimitDisplayLabel("Opus 4.5")).toBe("Opus 4.5");
    expect(formatRateLimitDisplayLabel("Usage credits")).toBe("Usage credits");
    expect(formatRateLimitDisplayLabel("Weekly (overage)")).toBe("Weekly (overage)");
    expect(formatRateLimitDisplayLabel("monthly")).toBe("monthly");
  });
});

describe("deriveVisibleRateLimitRows", () => {
  it("keeps identities that differ only by case or separators", () => {
    const rows = deriveVisibleRateLimitRows([
      {
        provider: "claudeAgent",
        updatedAt: "2099-04-08T18:00:00.000Z",
        limits: [
          { window: "a_b", usedPercent: 10 },
          { window: "A B", usedPercent: 20 },
        ],
      },
    ]);

    expect(rows.map(({ label, remainingPercent }) => ({ label, remainingPercent }))).toEqual([
      { label: "A B", remainingPercent: 80 },
      { label: "a_b", remainingPercent: 90 },
    ]);
  });

  it("orders known windows, unmapped labels, credits and Current deterministically", () => {
    const rows = deriveVisibleRateLimitRows([
      {
        provider: "claudeAgent",
        updatedAt: "2099-04-08T18:00:00.000Z",
        limits: [
          { window: "Current", usedPercent: 1 },
          { window: "Usage credits", usedPercent: 2 },
          { window: "Monthly", usedPercent: 3 },
          { window: "Core 5h", usedPercent: 4 },
          { window: "Opus", usedPercent: 5 },
          { window: "Weekly", usedPercent: 6 },
        ],
      },
    ]);

    expect(rows.map((row) => row.label)).toEqual([
      "Weekly",
      "Opus",
      "Core 5h",
      "Monthly",
      "Usage credits",
      "Current",
    ]);
  });
});
