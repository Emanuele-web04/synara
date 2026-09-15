import "../../index.css";

import { MessageId } from "@synara/contracts";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
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
