import "../../index.css";

import { MessageId } from "@synara/contracts";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import type { TimelineEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";
import { deriveTimelineEntries } from "../../workLog";
import { MessagesTimeline } from "./MessagesTimeline";

const now = "2026-09-12T12:00:00.000Z";
const text = "知道。\n\n- 前端 Web 项目：`/project/web`\n- `erp-code` 通常指 C# ERP 项目。";
const message: ChatMessage = {
  id: MessageId.makeUnsafe("assistant-cjk"),
  role: "assistant",
  text,
  createdAt: now,
  streaming: false,
  textSegments: Array.from(text, (text, index) => ({
    sequence: index + 1,
    startedAt: now,
    endedAt: now,
    text,
  })),
};

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

it("renders a reopened tokenized CJK reply as one intact Markdown list", async () => {
  const incoming = JSON.parse(JSON.stringify(message)) as ChatMessage;
  const result = await render(
    <div style={{ height: 600 }}>
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={deriveTimelineEntries([incoming], [], [])}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso={now}
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
    </div>,
  );
  cleanup = result.unmount;
  await expect.poll(() => document.querySelectorAll("li").length).toBe(2);
  expect(Array.from(document.querySelectorAll("li"), (item) => item.textContent)).toEqual([
    "前端 Web 项目：/project/web",
    "erp-code 通常指 C# ERP 项目。",
  ]);
  expect(Array.from(document.querySelectorAll("code"), (item) => item.textContent)).toEqual([
    "/project/web",
    "erp-code",
  ]);
  expect(document.querySelectorAll(".chat-message-segment")).toHaveLength(0);
});

const at = (second: number) => `2026-09-12T12:00:${String(second).padStart(2, "0")}.000Z`;

// Left edge of the first rendered glyph inside `root`.
function firstGlyphLeft(root: Element): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      (node.textContent ?? "").trim().length > 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP,
  });
  const textNode = walker.nextNode();
  if (!textNode) throw new Error("No text rendered.");
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, 1);
  return range.getBoundingClientRect().left;
}

it("starts streamed segment text at the same x as a whole assistant reply", async () => {
  const reply: ChatMessage = {
    id: MessageId.makeUnsafe("assistant-whole"),
    role: "assistant",
    text: "Whole reply text.",
    createdAt: at(1),
    completedAt: at(1),
    streaming: false,
  };
  const segmented: ChatMessage = {
    id: MessageId.makeUnsafe("assistant-segmented"),
    role: "assistant",
    text: "Segment one text.Segment two text.",
    createdAt: at(2),
    streaming: true,
    textSegments: [
      { sequence: 1, startedAt: at(2), endedAt: at(2), text: "Segment one text." },
      { sequence: 3, startedAt: at(4), endedAt: at(4), text: "Segment two text." },
    ],
  };
  const timelineEntries: TimelineEntry[] = [
    { id: "reply", kind: "message", createdAt: at(1), message: reply },
    {
      id: "segment-0",
      kind: "message-segment",
      createdAt: at(2),
      sequence: 1,
      message: segmented,
      segmentIndex: 0,
    },
    {
      id: "tool",
      kind: "work",
      createdAt: at(3),
      entry: { id: "tool", createdAt: at(3), label: "Ran command", tone: "tool", command: "ls" },
    },
    {
      id: "segment-1",
      kind: "message-segment",
      createdAt: at(4),
      sequence: 3,
      message: segmented,
      segmentIndex: 1,
    },
  ];
  const result = await render(
    <div style={{ height: 600, width: 640 }}>
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={timelineEntries}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso={at(5)}
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
    </div>,
  );
  cleanup = result.unmount;
  await expect.poll(() => document.querySelectorAll(".chat-message-segment").length).toBe(2);
  const replyBody = document.querySelector("[data-assistant-message-id='assistant-whole']");
  expect(replyBody).not.toBeNull();
  const replyLeft = firstGlyphLeft(replyBody!);
  for (const segment of document.querySelectorAll(".chat-message-segment")) {
    expect(firstGlyphLeft(segment)).toBe(replyLeft);
  }
});
