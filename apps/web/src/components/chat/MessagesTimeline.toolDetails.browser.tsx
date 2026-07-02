// FILE: MessagesTimeline.toolDetails.browser.tsx
// Purpose: Browser regressions for inline tool-call detail expand/collapse motion.
// Layer: Vitest browser tests

import "../../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";

function ToolDetailsTimeline() {
  return (
    <MessagesTimeline
      hasMessages
      isWorking={false}
      activeTurnInProgress={false}
      activeTurnStartedAt={null}
      timelineEntries={[
        {
          id: "entry-command-details",
          kind: "work",
          createdAt: "2026-03-17T19:12:28.000Z",
          entry: {
            id: "work-command-details",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            toolTitle: "Searched",
            command: `rg -n "toolDetails" apps/web/src`,
            toolDetails: {
              kind: "command",
              title: "Searched",
              command: `rg -n "toolDetails" apps/web/src`,
              output: {
                stdout: "apps/web/src/session-logic.ts:55: toolDetails",
              },
            },
          },
        },
      ]}
      turnDiffSummaryByAssistantMessageId={new Map()}
      nowIso="2026-03-17T19:12:30.000Z"
      expandedWorkGroups={{}}
      onToggleWorkGroup={() => {}}
      onOpenTurnDiff={() => {}}
      revertTurnCountByUserMessageId={new Map()}
      onRevertUserMessage={() => {}}
      isRevertingCheckpoint={false}
      onImageExpand={() => {}}
      markdownCwd={undefined}
      resolvedTheme="dark"
      timestampFormat="locale"
      workspaceRoot={undefined}
    />
  );
}

describe("MessagesTimeline tool details", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens and closes command details with the shared disclosure motion", async () => {
    const screen = await render(<ToolDetailsTimeline />);
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;
    const pendingFrames: Array<FrameRequestCallback | null> = [];

    try {
      const trigger = document.querySelector<HTMLButtonElement>(
        '[data-tool-detail-trigger="true"]',
      );
      expect(trigger).not.toBeNull();
      expect(trigger?.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector("[data-tool-details-inline='true']")).toBeNull();

      window.requestAnimationFrame = (callback: FrameRequestCallback) => {
        pendingFrames.push(callback);
        return pendingFrames.length;
      };
      window.cancelAnimationFrame = (handle: number) => {
        pendingFrames[handle - 1] = null;
      };

      trigger?.click();

      await expect.poll(() => trigger?.getAttribute("aria-expanded")).toBe("true");
      await expect
        .poll(() => document.querySelector("[data-tool-details-inline='true']") !== null)
        .toBe(true);
      const openingHiddenRegion = document
        .querySelector("[data-tool-details-inline='true']")
        ?.closest("[aria-hidden='true']");
      expect(openingHiddenRegion).not.toBeNull();
      expect(openingHiddenRegion?.hasAttribute("inert")).toBe(true);

      const framesToFlush = pendingFrames.splice(0);
      expect(framesToFlush.some((frame) => frame !== null)).toBe(true);
      for (const frame of framesToFlush) {
        frame?.(performance.now());
      }
      window.requestAnimationFrame = originalRequestAnimationFrame;
      window.cancelAnimationFrame = originalCancelAnimationFrame;

      await expect
        .poll(
          () =>
            document
              .querySelector("[data-tool-details-inline='true']")
              ?.closest("[aria-hidden='true']") ?? null,
        )
        .toBeNull();
      expect(document.body.textContent ?? "").toContain(`rg -n "toolDetails" apps/web/src`);

      trigger?.click();

      await expect.poll(() => trigger?.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector("[data-tool-details-inline='true']")).not.toBeNull();
      const closingHiddenRegion = document
        .querySelector("[data-tool-details-inline='true']")
        ?.closest("[aria-hidden='true']");
      expect(closingHiddenRegion).not.toBeNull();
      expect(closingHiddenRegion?.hasAttribute("inert")).toBe(true);

      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 320);
      });
      await expect
        .poll(() => document.querySelector("[data-tool-details-inline='true']"))
        .toBeNull();
    } finally {
      window.requestAnimationFrame = originalRequestAnimationFrame;
      window.cancelAnimationFrame = originalCancelAnimationFrame;
      await screen.unmount();
    }
  });
});
