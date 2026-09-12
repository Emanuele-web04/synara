// FILE: ProviderUsageMenuControl.test.tsx
// Purpose: Verifies the compact header/popover usage menu keeps every window row,
// selects the most constrained row, and renders identity labels through the shared rows.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ProviderRateLimit } from "~/lib/rateLimits";

import { buildProviderUsageMenuModel } from "./ProviderUsageMenuControl";
import { ProviderUsagePanelContent } from "./ProviderUsagePanelContent";

const rateLimits: ReadonlyArray<ProviderRateLimit> = [
  {
    provider: "claudeAgent",
    updatedAt: "2099-04-08T18:00:00.000Z",
    limits: [
      { window: "5h", usedPercent: 0, windowDurationMins: 300 },
      { window: "Weekly", usedPercent: 45, windowDurationMins: 10080 },
      { window: "Fable", usedPercent: 89, windowDurationMins: 10080 },
      { window: "Sonnet", usedPercent: 20, windowDurationMins: 10080 },
      { window: "Opus", usedPercent: 10, windowDurationMins: 10080 },
      { window: "Weekly (overage)", usedPercent: 90, windowDurationMins: 10080 },
      { window: "Usage credits", usedPercent: 80 },
    ],
  },
];

function buildModel(limits: ReadonlyArray<ProviderRateLimit> = rateLimits) {
  return buildProviderUsageMenuModel({
    provider: "claudeAgent",
    providerSnapshot: undefined,
    usageSummary: {
      learnMoreHref: null,
      rateLimits: limits,
      usageLines: [],
      usageNotice: undefined,
      isLoading: false,
    },
  });
}

describe("buildProviderUsageMenuModel", () => {
  it("keeps every window row and selects the most constrained one", () => {
    const model = buildModel();

    expect(model.menuTitle).toBe("Claude usage");
    expect(model.rows.map((row) => row.displayLabel)).toEqual([
      "5h",
      "Weekly",
      "Fable",
      "Sonnet",
      "Opus",
      "Weekly (overage)",
      "Usage credits",
    ]);
    expect(model.primaryRow?.displayLabel).toBe("Weekly (overage)");
    expect(model.primaryRow?.remainingLabel).toBe("10%");
  });

  it("keeps the first row in deterministic order when remaining values tie", () => {
    const model = buildModel([
      {
        provider: "claudeAgent",
        updatedAt: "2099-04-08T18:00:00.000Z",
        limits: [
          { window: "Opus", usedPercent: 50 },
          { window: "Sonnet", usedPercent: 50 },
        ],
      },
    ]);

    expect(model.primaryRow?.displayLabel).toBe("Sonnet");
  });
});

describe("ProviderUsagePanelContent", () => {
  it("renders every model window row with its remaining percentage", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsagePanelContent provider="claudeAgent" rateLimits={rateLimits} />,
    );

    expect(markup).toContain("Fable");
    expect(markup).toContain("Sonnet");
    expect(markup).toContain("Weekly (overage)");
    expect(markup).toContain("Usage credits");
    expect(markup).toContain("11% left");
    expect(markup).toContain("10% left");
  });
});
