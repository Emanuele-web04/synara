// FILE: MessagesTimeline.workingSpacing.browser.tsx
// Purpose: Browser regression for the live "Thinking" row's place in the transcript
//          rhythm: it is a 24px row one 14px step below the live tail, whether that
//          tail ends in a tool row or in streaming text.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId, TurnId } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";
import type { TimelineEntry } from "../../session-logic";

const CREATED_AT = "2026-03-17T19:12:28.000Z";
const LIVE_TURN_ID = TurnId.makeUnsafe("turn-live");
const ASSISTANT_TEXT = "Looking at the header layout.";
// WORK_ROW_STACK_CLASS_NAME's gap-3.5.
const WORK_ROW_STEP_PX = 14;

function messageEntry(id: string, role: "user" | "assistant", text: string): TimelineEntry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.makeUnsafe(id),
      role,
      text,
      createdAt: CREATED_AT,
      streaming: role === "assistant",
      ...(role === "assistant" ? { turnId: LIVE_TURN_ID } : {}),
    },
  };
}

function commandEntry(id: string, command: string): TimelineEntry {
  return {
    id: `entry-${id}`,
    kind: "work",
    createdAt: CREATED_AT,
    entry: {
      id,
      createdAt: CREATED_AT,
      label: "Ran command",
      tone: "tool",
      itemType: "command_execution",
      toolStatus: "completed",
      command,
      turnId: LIVE_TURN_ID,
    },
  };
}

function textNode(text: string): Text {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.trim() === text) return node as Text;
  }
  throw new Error(`No text node reads "${text}"`);
}

function assistantTextBottom(): number {
  return textNode(ASSISTANT_TEXT).parentElement!.closest("p")!.getBoundingClientRect().bottom;
}

function thinkingRowRect(): DOMRect {
  const row = document.querySelector<HTMLElement>(
    '[data-timeline-row-kind="working"] .shimmer-group',
  );
  if (!row) throw new Error("No Thinking row rendered");
  return row.getBoundingClientRect();
}

async function renderLiveTurn(entries: TimelineEntry[]) {
  const host = document.createElement("div");
  host.style.cssText = "display:block;width:600px;height:480px;overflow:hidden;";
  document.body.append(host);
  const screen = await render(
    <div style={{ height: 480, width: "100%" }}>
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnId={LIVE_TURN_ID}
        activeTurnStartedAt="2026-03-17T19:12:29.000Z"
        timelineEntries={[
          messageEntry("user-1", "user", "Check the header."),
          messageEntry("assistant-1", "assistant", ASSISTANT_TEXT),
          ...entries,
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
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </div>,
    { container: host },
  );
  await expect.poll(() => document.body.textContent?.includes("Thinking")).toBe(true);
  await expect.poll(() => document.body.textContent?.includes(ASSISTANT_TEXT)).toBe(true);
  await document.fonts.ready;
  return async () => {
    await screen.unmount();
    host.remove();
  };
}

describe("MessagesTimeline working row spacing", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("stacks Thinking one work-row step below the last tool row", async () => {
    const cleanup = await renderLiveTurn([commandEntry("command-1", "the-command")]);
    try {
      await expect.poll(() => document.body.textContent?.includes("the-command")).toBe(true);
      const toolLabel = textNode("the-command").parentElement!;
      // The tool row's 24px box: its item in the work-row stack.
      let toolItem: HTMLElement = toolLabel;
      while (!toolItem.parentElement!.classList.contains("gap-3.5")) {
        toolItem = toolItem.parentElement!;
      }
      const toolStack = toolItem.parentElement!.getBoundingClientRect();
      const thinking = thinkingRowRect();

      expect(thinking.height).toBeCloseTo(toolItem.getBoundingClientRect().height, 0);
      expect(thinking.top - toolItem.getBoundingClientRect().bottom).toBeCloseTo(
        WORK_ROW_STEP_PX,
        0,
      );
      // Text above a tool stack keeps the same step.
      expect(toolStack.top - assistantTextBottom()).toBeCloseTo(WORK_ROW_STEP_PX, 0);
    } finally {
      await cleanup();
    }
  });

  it("keeps Thinking one work-row step below streaming text", async () => {
    const cleanup = await renderLiveTurn([]);
    try {
      expect(thinkingRowRect().top - assistantTextBottom()).toBeCloseTo(WORK_ROW_STEP_PX, 0);
    } finally {
      await cleanup();
    }
  });
});
