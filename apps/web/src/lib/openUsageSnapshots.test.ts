import { describe, expect, it } from "vitest";

import {
  formatOpenUsageProgressSummary,
  normalizeOpenUsageProviderSnapshots,
  openUsageProgressRemainingPercent,
  openUsageSidebarProgressLines,
} from "./openUsageSnapshots";

describe("openUsageSnapshots", () => {
  it("normalizes provider snapshots from the CrossUsage collection endpoint", () => {
    expect(
      normalizeOpenUsageProviderSnapshots([
        {
          providerId: "codex",
          displayName: "Codex",
          plan: "Plus",
          fetchedAt: "2099-04-08T18:00:00.000Z",
          lines: [
            {
              type: "progress",
              label: "Session",
              used: 20,
              limit: 100,
              format: { kind: "percent" },
              resetsAt: "2099-04-08T21:18:00.000Z",
            },
            {
              type: "text",
              label: "Today",
              value: "$5.17 · 9.2M tokens",
            },
          ],
        },
        {
          providerId: "cursor",
          displayName: "Cursor",
          fetchedAt: "2099-04-08T18:01:00.000Z",
          lines: [
            {
              type: "progress",
              label: "Fast requests",
              used: 42,
              limit: 100,
              format: { kind: "percent" },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        providerId: "codex",
        displayName: "Codex",
        plan: "Plus",
        fetchedAt: "2099-04-08T18:00:00.000Z",
        providerKind: "codex",
        lines: [
          {
            type: "progress",
            label: "Session",
            used: 20,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: "2099-04-08T21:18:00.000Z",
          },
          {
            type: "text",
            label: "Today",
            value: "$5.17 · 9.2M tokens",
          },
        ],
      },
      {
        providerId: "cursor",
        displayName: "Cursor",
        fetchedAt: "2099-04-08T18:01:00.000Z",
        providerKind: "cursor",
        lines: [
          {
            type: "progress",
            label: "Fast requests",
            used: 42,
            limit: 100,
            format: { kind: "percent" },
          },
        ],
      },
    ]);
  });

  it("formats progress summaries and selects sidebar progress lines", () => {
    const [snapshot] = normalizeOpenUsageProviderSnapshots([
      {
        providerId: "claude",
        displayName: "Claude",
        fetchedAt: "2099-04-08T18:00:00.000Z",
        lines: [
          {
            type: "progress",
            label: "Session",
            used: 25,
            limit: 100,
            format: { kind: "percent" },
          },
          {
            type: "progress",
            label: "Weekly",
            used: 10,
            limit: 100,
            format: { kind: "percent" },
          },
        ],
      },
    ]);

    expect(snapshot).toBeDefined();
    if (!snapshot) return;

    const [primary] = openUsageSidebarProgressLines(snapshot);
    expect(primary).toBeDefined();
    if (!primary) return;

    expect(openUsageProgressRemainingPercent(primary)).toBe(75);
    expect(formatOpenUsageProgressSummary(primary)).toBe("75% left");
  });
});
