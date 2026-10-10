// Verify the actual tooltip keeps the applied mode separate from runtime usage.
import { EventId, type OrchestrationThreadActivity } from "@synara/contracts";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  deriveAppliedContextWindowSelection,
  deriveContextWindowSelectionStatus,
  deriveLatestContextWindowState,
} from "~/lib/contextWindow";
import { ContextWindowMeter } from "./ContextWindowMeter";

it("shows Auto as applied with the 967k runtime threshold and no pending Auto", async () => {
  const activities: OrchestrationThreadActivity[] = [
    {
      id: EventId.makeUnsafe("config"),
      kind: "context-window.configured",
      tone: "info",
      summary: "Auto",
      payload: { cleared: true },
      turnId: null,
      createdAt: "2026-09-17T00:00:00Z",
    },
    {
      id: EventId.makeUnsafe("usage"),
      kind: "context-window.updated",
      tone: "info",
      summary: "Usage",
      payload: { usedTokens: 500_000, maxTokens: 967_000, usedPercent: 51.7 },
      turnId: null,
      createdAt: "2026-09-17T00:00:01Z",
    },
  ];
  const usage = deriveLatestContextWindowState(activities).snapshot!;
  const status = deriveContextWindowSelectionStatus({
    activeSnapshot: usage,
    selectedValue: "auto",
    appliedValue: deriveAppliedContextWindowSelection(activities),
  });
  await render(
    <ContextWindowMeter
      usage={usage}
      showClaudeCache
      activeWindowLabel={status.activeLabel}
      pendingWindowLabel={status.pendingSelectedLabel}
    />,
  );
  await page.getByRole("button", { name: "Context window 52% used" }).click();
  await expect.element(page.getByText("Auto-compact target: Auto")).toBeVisible();
  await expect.element(page.getByText("Active context limit: 967k tokens")).toBeVisible();
  await expect.element(page.getByText("Next turn:", { exact: false })).not.toBeInTheDocument();
});
