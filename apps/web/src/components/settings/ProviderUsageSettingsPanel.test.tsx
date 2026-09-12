// FILE: ProviderUsageSettingsPanel.test.tsx
// Purpose: Renders the real Settings → Usage panel with product-shaped snapshots to prove
// model-scoped weekly windows reach the card instead of collapsing into the account Weekly row.

import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { serverQueryKeys } from "~/lib/serverReactQuery";

import { ProviderUsageSettingsPanel } from "./ProviderUsageSettingsPanel";

vi.mock("~/appSettings", () => ({
  useAppSettings: () => ({ settings: { codexHomePath: "" } }),
}));

function claudeSnapshot(
  input: Partial<ServerProviderUsageSnapshot> = {},
): ServerProviderUsageSnapshot {
  return {
    provider: "claudeAgent",
    updatedAt: "2099-04-08T18:00:00.000Z",
    limits: [
      { window: "5h", usedPercent: 0, windowDurationMins: 300 },
      { window: "Weekly", usedPercent: 45, windowDurationMins: 10080 },
      { window: "Fable", usedPercent: 89, windowDurationMins: 10080 },
      { window: "Sonnet", usedPercent: 20, windowDurationMins: 10080 },
      { window: "Opus", usedPercent: 10, windowDurationMins: 10080 },
      { window: "Weekly (overage)", usedPercent: 90, windowDurationMins: 10080 },
    ],
    usageLines: [{ label: "Extra usage", value: "$5.00 of $100.00" }],
    source: "test",
    status: "ok",
    planName: "Max (5x)",
    ...input,
  };
}

function renderPanel(snapshot: ServerProviderUsageSnapshot) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [snapshot]);

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ProviderUsageSettingsPanel />
    </QueryClientProvider>,
  );
}

describe("ProviderUsageSettingsPanel", () => {
  it("renders every model-scoped weekly window with its own remaining percentage", () => {
    const markup = renderPanel(claudeSnapshot());

    expect(markup).toContain("Claude");
    expect(markup).toContain("Max (5x)");
    expect(markup).toContain("Weekly");
    expect(markup).toContain("Fable");
    expect(markup).toContain("Sonnet");
    expect(markup).toContain("Opus");
    expect(markup).toContain("Weekly (overage)");
    expect(markup).toContain("11% left");
    expect(markup).toContain("10% left");
    expect(markup).toContain("Extra usage");
  });

  it("shows the signed-out state without inventing usage rows", () => {
    const markup = renderPanel(
      claudeSnapshot({
        status: "needs-auth",
        detail: "Sign in with `claude` to see usage.",
        planName: undefined,
        limits: [],
        usageLines: [],
      }),
    );

    expect(markup).toContain("Not signed in");
    expect(markup).toContain("Sign in with");
    expect(markup).not.toContain("Fable");
  });
});
