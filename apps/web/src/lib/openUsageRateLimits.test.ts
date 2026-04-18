import { describe, expect, it } from "vitest";

import {
  normalizeOpenUsageSnapshot,
  normalizeOpenUsageUsageLines,
  openUsageProviderIdForProvider,
} from "./openUsageRateLimits";
import { mergeProviderRateLimits } from "./rateLimits";

describe("openUsageRateLimits", () => {
  it("normalizes OpenUsage progress lines into shared provider rate limits", () => {
    expect(
      normalizeOpenUsageSnapshot({
        providerId: "codex",
        fetchedAt: "2099-04-08T18:00:00.000Z",
        lines: [
          {
            type: "progress",
            label: "Session",
            used: 20,
            limit: 100,
            resetsAt: "2099-04-08T21:18:00.000Z",
            periodDurationMs: 18_000_000,
          },
          {
            type: "progress",
            label: "Weekly",
            used: 10,
            limit: 100,
            resetsAt: "2099-04-14T18:00:00.000Z",
            periodDurationMs: 604_800_000,
          },
        ],
      }),
    ).toEqual({
      provider: "codex",
      updatedAt: "2099-04-08T18:00:00.000Z",
      limits: [
        {
          window: "5h",
          usedPercent: 20,
          resetsAt: "2099-04-08T21:18:00.000Z",
          windowDurationMins: 300,
        },
        {
          window: "Weekly",
          usedPercent: 10,
          resetsAt: "2099-04-14T18:00:00.000Z",
          windowDurationMins: 10080,
        },
      ],
    });
  });

  it("merges runtime and OpenUsage windows for the same provider", () => {
    expect(
      mergeProviderRateLimits(
        [
          {
            provider: "codex",
            updatedAt: "2099-04-08T18:05:00.000Z",
            limits: [
              {
                window: "5h",
                usedPercent: 22,
                resetsAt: "2099-04-08T21:18:00.000Z",
                windowDurationMins: 300,
              },
            ],
          },
        ],
        [
          {
            provider: "codex",
            updatedAt: "2099-04-08T18:00:00.000Z",
            limits: [
              {
                window: "Weekly",
                usedPercent: 10,
                resetsAt: "2099-04-14T18:00:00.000Z",
                windowDurationMins: 10080,
              },
            ],
          },
        ],
      ),
    ).toEqual([
      {
        provider: "codex",
        updatedAt: "2099-04-08T18:05:00.000Z",
        limits: [
          {
            window: "5h",
            usedPercent: 22,
            resetsAt: "2099-04-08T21:18:00.000Z",
            windowDurationMins: 300,
          },
          {
            window: "Weekly",
            usedPercent: 10,
            resetsAt: "2099-04-14T18:00:00.000Z",
            windowDurationMins: 10080,
          },
        ],
      },
    ]);
  });

  it("preserves OpenUsage text lines for daily token usage summaries", () => {
    expect(
      normalizeOpenUsageUsageLines({
        providerId: "codex",
        fetchedAt: "2099-04-08T18:00:00.000Z",
        lines: [
          {
            type: "progress",
            label: "Session",
            used: 20,
            limit: 100,
          },
          {
            type: "text",
            label: "Today",
            value: "$5.17 · 9.2M tokens",
          },
          {
            type: "text",
            label: "Yesterday",
            value: "$2.04 · 3.1M tokens",
            subtitle: "via ccusage",
          },
        ],
      }),
    ).toEqual([
      {
        label: "Today",
        value: "$5.17 · 9.2M tokens",
      },
      {
        label: "Yesterday",
        value: "$2.04 · 3.1M tokens",
        subtitle: "via ccusage",
      },
    ]);
  });

  it("maps Gemini provider ids in both directions", () => {
    expect(openUsageProviderIdForProvider("gemini")).toBe("gemini");
    expect(
      normalizeOpenUsageSnapshot({
        providerId: "gemini",
        fetchedAt: "2099-04-08T18:00:00.000Z",
        lines: [{ type: "progress", label: "Daily", used: 5, limit: 10 }],
      }),
    ).toEqual({
      provider: "gemini",
      updatedAt: "2099-04-08T18:00:00.000Z",
      limits: [{ window: "Daily", usedPercent: 50 }],
    });
  });
});
