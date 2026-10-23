// FILE: useChatWorkLog.browser.tsx
// Purpose: Guards the streaming fast path: a text-only flush (new messages array, same
//          turns, same activities) must not re-derive the work log or the subagent strip.
// Layer: Web chat hook browser tests
// Depends on: the real store-backed useChatWorkLog hook.

import { MessageId, TurnId } from "@synara/contracts";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { makeActivity, makeThread } from "../../storeTestFixtures";
import type { ChatMessage, Thread } from "../../types";
import { useChatWorkLog } from "./useChatWorkLog";

type WorkLogResult = ReturnType<typeof useChatWorkLog>;

const CREATED_AT = "2026-10-01T12:00:00.000Z";
const LIVE_TURN_ID = TurnId.makeUnsafe("turn-live");
const ACTIVITIES = [
  makeActivity({
    id: "read-completed",
    sequence: 1,
    kind: "tool.completed",
    summary: "Read file",
    turnId: "turn-live",
    payload: { itemType: "dynamic_tool_call", data: { toolCallId: "read", toolName: "Read" } },
  }),
];

function assistantMessage(text: string, turnId: TurnId = LIVE_TURN_ID): ChatMessage {
  return {
    id: MessageId.makeUnsafe(`assistant-${turnId}`),
    role: "assistant",
    text,
    turnId,
    createdAt: CREATED_AT,
    streaming: true,
  };
}

function liveThread(messages: ChatMessage[]): Thread {
  return makeThread({
    messages,
    activities: ACTIVITIES,
    latestTurn: {
      turnId: LIVE_TURN_ID,
      state: "running",
      requestedAt: CREATED_AT,
      startedAt: CREATED_AT,
      completedAt: null,
      assistantMessageId: null,
    },
  });
}

function WorkLogProbe(props: { thread: Thread; results: WorkLogResult[] }) {
  props.results.push(
    useChatWorkLog({ activeThread: props.thread, latestTurnSettled: false, latestTurnLive: true }),
  );
  return null;
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

it("keeps the derived work log when a text flush keeps the same turns", async () => {
  const results: WorkLogResult[] = [];
  const screen = await render(
    <WorkLogProbe thread={liveThread([assistantMessage("Working")])} results={results} />,
  );
  cleanup = screen.unmount;
  const first = results.at(-1)!;
  const rendersBeforeFlush = results.length;
  expect(first.workLogEntries.map((entry) => entry.id)).toEqual(["read-completed"]);

  await screen.rerender(
    <WorkLogProbe thread={liveThread([assistantMessage("Working on it")])} results={results} />,
  );
  const afterTextFlush = results.at(-1)!;
  expect(results.length).toBeGreaterThan(rendersBeforeFlush);
  expect(afterTextFlush.workLogEntries).toBe(first.workLogEntries);
  expect(afterTextFlush.composerSubagentStripItems).toBe(first.composerSubagentStripItems);
  expect(afterTextFlush.workflowRunState).toBe(first.workflowRunState);

  // A message from another turn changes which history is visible: that does re-derive.
  const earlierTurn = TurnId.makeUnsafe("turn-earlier");
  await screen.rerender(
    <WorkLogProbe
      thread={liveThread([assistantMessage("Earlier", earlierTurn), assistantMessage("Working")])}
      results={results}
    />,
  );
  expect(results.at(-1)!.workLogEntries).not.toBe(first.workLogEntries);
});
