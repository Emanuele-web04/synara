import { EventId, MessageId, ThreadId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { AppState } from "../store";
import type { ChatMessage, Thread, ThreadShell } from "../types";
import { createThreadLineageSelector } from "./ChatView.selectors";

const rootThreadId = ThreadId.makeUnsafe("thread-root");
const childThreadId = ThreadId.makeUnsafe("thread-child");
const unrelatedThreadId = ThreadId.makeUnsafe("thread-unrelated");
const messageId = MessageId.makeUnsafe("message-1");

const rootShell = {
  id: rootThreadId,
  title: "Root thread",
} as ThreadShell;

const childShell = {
  id: childThreadId,
  title: "Child thread",
  parentThreadId: rootThreadId,
} as ThreadShell;

const unrelatedShell = {
  id: unrelatedThreadId,
  title: "Unrelated thread",
} as ThreadShell;

const threadIds = [rootThreadId, childThreadId];
const threadShellById = {
  [rootThreadId]: rootShell,
  [childThreadId]: childShell,
};

const rootActivity = {
  id: EventId.makeUnsafe("activity-root"),
  kind: "tool.completed",
  tone: "tool",
  summary: "Delegated work",
  payload: {},
  turnId: TurnId.makeUnsafe("turn-1"),
  createdAt: "2026-06-01T00:00:00.000Z",
} satisfies Thread["activities"][number];

const activityIdsByThreadId = {
  [rootThreadId]: [rootActivity.id],
};

const activityByThreadId = {
  [rootThreadId]: {
    [rootActivity.id]: rootActivity,
  },
};

const message = {
  id: messageId,
  role: "assistant",
  text: "Streaming detail changed",
  createdAt: "2026-06-01T00:00:01.000Z",
  streaming: true,
} satisfies ChatMessage;

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    threadIds,
    threadShellById,
    activityIdsByThreadId,
    activityByThreadId,
    messageIdsByThreadId: {},
    messageByThreadId: {},
    ...overrides,
  } as AppState;
}

describe("createThreadLineageSelector", () => {
  it("stays stable when only message detail slices change", () => {
    const selectLineage = createThreadLineageSelector(childThreadId);
    const before = selectLineage(makeState());
    const after = selectLineage(
      makeState({
        messageIdsByThreadId: {
          [childThreadId]: [messageId],
        },
        messageByThreadId: {
          [childThreadId]: {
            [messageId]: message,
          },
        },
      }),
    );

    expect(after).toBe(before);
    expect(after.map((thread) => thread.id)).toEqual([rootThreadId, childThreadId]);
  });

  it("updates when parent activity identity hints change", () => {
    const selectLineage = createThreadLineageSelector(childThreadId);
    const before = selectLineage(makeState());
    const nextActivity = {
      ...rootActivity,
      payload: { data: { item: { agents: [{ id: "agent-1", nickname: "Planner" }] } } },
    };
    const after = selectLineage(
      makeState({
        activityByThreadId: {
          [rootThreadId]: {
            [rootActivity.id]: nextActivity,
          },
        },
      }),
    );

    expect(after).not.toBe(before);
    expect(after[0]?.activities[0]).toBe(nextActivity);
  });

  it("stays stable when unrelated thread shells change", () => {
    const selectLineage = createThreadLineageSelector(childThreadId);
    const before = selectLineage(makeState());
    const after = selectLineage(
      makeState({
        threadIds: [...threadIds, unrelatedThreadId],
        threadShellById: {
          ...threadShellById,
          [unrelatedThreadId]: unrelatedShell,
        },
      }),
    );

    expect(after).toBe(before);
  });
});
