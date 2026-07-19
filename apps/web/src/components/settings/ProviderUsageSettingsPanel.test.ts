import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { completeProviderUsageRefresh } from "./ProviderUsageSettingsPanel";

describe("completeProviderUsageRefresh", () => {
  it("returns only supported providers and replaces omitted snapshots", () => {
    const claudeSnapshot: ServerProviderUsageSnapshot = {
      provider: "claudeAgent",
      updatedAt: "2026-07-18T12:00:00.000Z",
      limits: [{ window: "Weekly", usedPercent: 42 }],
      usageLines: [],
      source: "test",
      status: "ok",
    };

    const snapshots = completeProviderUsageRefresh([claudeSnapshot]);

    expect(snapshots.map((snapshot) => snapshot.provider)).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
    ]);
    expect(snapshots.find((snapshot) => snapshot.provider === "claudeAgent")).toBe(claudeSnapshot);
    expect(snapshots.find((snapshot) => snapshot.provider === "codex")).toMatchObject({
      status: "error",
      detail: "Usage is currently unavailable.",
    });
    expect(snapshots.some((snapshot) => snapshot.provider === "antigravity")).toBe(false);
  });
});
