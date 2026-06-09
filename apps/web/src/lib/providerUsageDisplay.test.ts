import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deriveProviderUsageDisplayRows,
  providerUsagePaceDetails,
  selectPrimaryProviderUsageDisplayRow,
} from "./providerUsageDisplay";

describe("providerUsageDisplay", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("selects the most constrained display row for compact header chips", () => {
    const rows = deriveProviderUsageDisplayRows([
      {
        provider: "claudeAgent",
        updatedAt: "2099-04-08T18:00:00.000Z",
        limits: [
          {
            window: "5h",
            usedPercent: 7,
            resetsAt: "2099-04-08T20:00:00.000Z",
            windowDurationMins: 300,
          },
          {
            window: "Weekly",
            usedPercent: 84,
            resetsAt: "2099-04-14T18:00:00.000Z",
            windowDurationMins: 10080,
          },
        ],
      },
    ]);

    const primary = selectPrimaryProviderUsageDisplayRow(rows);

    expect(primary?.label).toBe("Weekly");
    expect(primary?.remainingLabel).toBe("16%");
    expect(primary?.remainingTone).toBe("warning");
  });

  it("centralizes reserve and eta details for display rows", () => {
    vi.setSystemTime("2026-06-09T12:00:00.000Z");

    const [row] = deriveProviderUsageDisplayRows([
      {
        provider: "codex",
        updatedAt: "2026-06-09T12:00:00.000Z",
        limits: [
          {
            window: "5h",
            usedPercent: 15,
            resetsAt: "2026-06-09T12:36:00.000Z",
            windowDurationMins: 300,
          },
        ],
      },
    ]);

    expect(row ? providerUsagePaceDetails(row) : null).toEqual({
      amountText: "73% in reserve",
      etaText: "Lasts until reset",
    });
  });

  it("infers standard window durations from normalized labels for pace details", () => {
    vi.setSystemTime("2026-06-09T12:00:00.000Z");

    const [row] = deriveProviderUsageDisplayRows([
      {
        provider: "codex",
        updatedAt: "2026-06-09T12:00:00.000Z",
        limits: [
          {
            window: "5h",
            usedPercent: 9,
            resetsAt: "2026-06-09T15:00:00.000Z",
          },
        ],
      },
    ]);

    expect(row?.markerPercent).toBe(60);
    expect(row ? providerUsagePaceDetails(row) : null).toEqual({
      amountText: "31% in reserve",
      etaText: "Lasts until reset",
    });
  });
});
