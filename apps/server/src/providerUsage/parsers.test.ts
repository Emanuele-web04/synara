import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { parseClaudeUsage } from "./providers/claude.ts";
import { parseCodexUsage } from "./providers/codex.ts";
import { parseCursorUsage } from "./providers/cursor.ts";
import { parseGeminiQuota } from "./providers/gemini.ts";

const NOW_MS = 1_738_000_000_000;

function limit(snapshot: ServerProviderUsageSnapshot, window: string) {
  return snapshot.limits.find((entry) => entry.window === window);
}

function usageLine(snapshot: ServerProviderUsageSnapshot, label: string) {
  return snapshot.usageLines.find((entry) => entry.label === label);
}

describe("parseCodexUsage", () => {
  const json = {
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 6, reset_at: 1_738_300_000 },
      secondary_window: {
        used_percent: 24,
        reset_at: 1_738_900_000,
        limit_window_seconds: 604_800,
      },
    },
    credits: { has_credits: true, balance: 5.39 },
  };

  it("maps rate-limit windows, credits, and plan", () => {
    const snapshot = parseCodexUsage({ json, nowMs: NOW_MS });
    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Plus");
    expect(limit(snapshot, "5h")?.usedPercent).toBe(6);
    expect(limit(snapshot, "5h")?.windowDurationMins).toBe(300);
    expect(limit(snapshot, "Weekly")?.usedPercent).toBe(24);
    expect(limit(snapshot, "Weekly")?.windowDurationMins).toBe(10_080);
    expect(usageLine(snapshot, "Credits")?.value).toContain("5.39");
  });

  it("prefers the response headers over the body for used percent", () => {
    const snapshot = parseCodexUsage({
      json,
      headers: { "x-codex-primary-used-percent": "12" },
      nowMs: NOW_MS,
    });
    expect(limit(snapshot, "5h")?.usedPercent).toBe(12);
  });
});

describe("parseClaudeUsage", () => {
  it("maps utilization windows and extra-usage credits", () => {
    const snapshot = parseClaudeUsage({
      json: {
        five_hour: { utilization: 25, resets_at: "2026-01-28T15:00:00Z" },
        seven_day: { utilization: 40, resets_at: "2026-02-01T00:00:00Z" },
        seven_day_sonnet: { utilization: 10, resets_at: "2026-02-01T00:00:00Z" },
        extra_usage: { is_enabled: true, used_credits: 500, monthly_limit: 10_000 },
      },
      nowMs: NOW_MS,
      planName: "Pro (2x)",
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Pro (2x)");
    expect(limit(snapshot, "5h")?.usedPercent).toBe(25);
    expect(limit(snapshot, "Weekly")?.usedPercent).toBe(40);
    expect(limit(snapshot, "Sonnet")?.usedPercent).toBe(10);
    const extra = usageLine(snapshot, "Extra usage");
    expect(extra?.value).toContain("5.00");
    expect(extra?.value).toContain("100.00");
  });
});

describe("parseCursorUsage", () => {
  it("maps total usage, on-demand spend, and credit grants", () => {
    const snapshot = parseCursorUsage({
      usage: {
        billingCycleEnd: "1771077734000",
        planUsage: {
          totalSpend: 23_222,
          limit: 40_000,
          remaining: 16_778,
          totalPercentUsed: 15.48,
        },
        spendLimitUsage: { individualLimit: 10_000, individualRemaining: 4_000, limitType: "user" },
      },
      credits: { hasCreditGrants: true, totalCents: 5_000, usedCents: 1_200 },
      planName: "Pro",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Pro");
    expect(limit(snapshot, "Current")?.usedPercent).toBeCloseTo(15.48);
    // used = (10000 - 4000) / 100 = $60.00 of $100.00
    expect(usageLine(snapshot, "On-demand")?.value).toContain("60.00");
    // remaining = (5000 - 1200) / 100 = $38.00 of $50.00
    expect(usageLine(snapshot, "Credits")?.value).toContain("38.00");
  });
});

describe("parseGeminiQuota", () => {
  it("groups remaining fractions into Pro/Flash used percent", () => {
    const snapshot = parseGeminiQuota({
      json: {
        quota: [
          { modelId: "gemini-2.5-pro", remainingFraction: 0.75, resetTime: "2026-02-01T00:00:00Z" },
          { modelId: "gemini-2.5-flash", remainingFraction: 0.5 },
        ],
      },
      nowMs: NOW_MS,
      planName: "Paid",
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Paid");
    expect(limit(snapshot, "Pro")?.usedPercent).toBeCloseTo(25);
    expect(limit(snapshot, "Flash")?.usedPercent).toBeCloseTo(50);
  });
});
