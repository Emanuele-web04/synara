import { describe, expect, it } from "vitest";
import { EventId, MessageId, TurnId } from "@synara/contracts";
import { makeDomainEvent, makeReadModelThread, makeState, makeThread } from "./storeTestFixtures";
import { getThreadFromState } from "./threadDerivation";
import {
  mergeThreadHistoryPage,
  restoreCachedThreadDetail,
  syncServerThreadDetailHotPath,
  markThreadDetailSyncFailedInClientState,
} from "./storeProjection";

import { applyOrchestrationEventsHotPath } from "./storeEventReducer";

const cursor = {
  messageId: MessageId.makeUnsafe("current"),
  createdAt: "2026-02-27T00:00:00.000Z",
  sequence: 10,
};
describe("thread history merge", () => {
  it("prepends missing historical rows while retaining newer live text and metadata", () => {
    const thread = makeThread({
      messages: [
        {
          id: cursor.messageId,
          role: "assistant",
          text: "live settled answer",
          streaming: false,
          createdAt: cursor.createdAt,
        },
      ],
      error: "current error",
    });
    const state = {
      ...makeState(thread),
      threadHistoryById: { [thread.id]: { totalMessageCount: 2, olderCursor: cursor } },
    };
    const page = {
      snapshotSequence: 8,
      history: { totalMessageCount: 2, olderCursor: null },
      thread: makeReadModelThread({
        messages: [
          {
            id: MessageId.makeUnsafe("older"),
            turnId: null,
            role: "user",
            text: "first",
            source: "native",
            streaming: false,
            createdAt: cursor.createdAt,
            updatedAt: cursor.createdAt,
          },
          {
            id: cursor.messageId,
            turnId: null,
            role: "assistant",
            text: "stale partial",
            source: "native",
            streaming: true,
            createdAt: cursor.createdAt,
            updatedAt: cursor.createdAt,
          },
        ],
      }),
    };
    const next = mergeThreadHistoryPage(state, page, cursor);
    expect(getThreadFromState(next, thread.id)?.messages.map((m) => m.text)).toEqual([
      "first",
      "live settled answer",
    ]);
    expect(getThreadFromState(next, thread.id)?.error).toBe("current error");
    expect(next.threadHistoryById?.[thread.id]?.olderCursor).toBeNull();
    expect(mergeThreadHistoryPage(next, page, cursor)).toBe(next);
  });
  it("restores display without granting authority or resurrecting a deleted thread", () => {
    const thread = makeThread();
    const snapshot = { snapshotSequence: 12, thread: makeReadModelThread({ messages: [] }) };
    const restored = restoreCachedThreadDetail(makeState(thread), snapshot);
    expect(restored.threadDetailSyncById?.[thread.id]).toBe("cached");
    const deleted = { ...makeState(thread), deletedThreadIdsById: { [thread.id]: 15 } };
    expect(restoreCachedThreadDetail(deleted, snapshot)).toBe(deleted);
  });
});

it("keeps loaded completed history across latest-tail reconciliation without regressing the live cursor", () => {
  const older = {
    id: MessageId.makeUnsafe("older"),
    turnId: null,
    role: "user" as const,
    text: "first",
    source: "native" as const,
    streaming: false,
    createdAt: cursor.createdAt,
    updatedAt: cursor.createdAt,
  };
  const current = { ...older, id: cursor.messageId, role: "assistant" as const, text: "latest" };
  const thread = makeThread({ messages: [older, current] });
  const state = {
    ...makeState(thread),
    threadHistoryById: { [thread.id]: { totalMessageCount: 2, olderCursor: null } },
    threadDetailAppliedSequenceById: { [thread.id]: 20 },
  };
  const next = syncServerThreadDetailHotPath(
    state,
    makeReadModelThread({ messages: [current] }),
    21,
    { totalMessageCount: 2, olderCursor: cursor },
  );
  expect(getThreadFromState(next, thread.id)?.messages.map((m) => m.text)).toEqual([
    "first",
    "latest",
  ]);
  expect(next.threadHistoryById?.[thread.id]?.olderCursor).toBeNull();
  expect(next.threadDetailAppliedSequenceById?.[thread.id]).toBe(21);
});

it("invalidates retained rows after rollback followed by growth to the same count", () => {
  const older = {
    id: MessageId.makeUnsafe("deleted-old"),
    turnId: null,
    role: "user" as const,
    text: "deleted",
    source: "native" as const,
    streaming: false,
    createdAt: cursor.createdAt,
    updatedAt: cursor.createdAt,
  };
  const current = { ...older, id: cursor.messageId, role: "assistant" as const, text: "latest" };
  const thread = makeThread({ messages: [older, current] });
  const state = {
    ...makeState(thread),
    threadHistoryById: {
      [thread.id]: { totalMessageCount: 2, olderCursor: null, revisionSequence: 0 },
    },
  };
  const next = syncServerThreadDetailHotPath(
    state,
    makeReadModelThread({ messages: [current] }),
    25,
    { totalMessageCount: 2, olderCursor: cursor, revisionSequence: 24 },
  );
  expect(getThreadFromState(next, thread.id)?.messages.map((m) => m.text)).toEqual(["latest"]);
  expect(next.threadHistoryById?.[thread.id]?.olderCursor).toEqual(cursor);
  const oldPage = {
    snapshotSequence: 23,
    history: { totalMessageCount: 2, olderCursor: null, revisionSequence: 0 },
    thread: makeReadModelThread({ messages: [older] }),
  };
  expect(mergeThreadHistoryPage(next, oldPage, cursor)).toBe(next);
});
it("keeps a failed cache verification unverified and preserves historical activities beyond the legacy cap", () => {
  const thread = makeThread();
  const snapshot = { snapshotSequence: 12, thread: makeReadModelThread({}) };
  const restored = restoreCachedThreadDetail(makeState(thread), snapshot);
  expect(
    markThreadDetailSyncFailedInClientState(restored, thread.id).threadDetailSyncById?.[thread.id],
  ).toBe("cached");
  const activities = Array.from({ length: 2105 }, (_, index) => ({
    id: EventId.makeUnsafe(`activity-${index}`),
    tone: "tool" as const,
    kind: "tool.completed",
    summary: `work ${index}`,
    payload: {},
    turnId: null,
    createdAt: cursor.createdAt,
  }));
  const current = activities.at(-1)!;
  const state = {
    ...makeState(makeThread({ activities: [current] })),
    threadHistoryById: {
      [thread.id]: {
        totalMessageCount: 0,
        olderCursor: null,
        olderActivityCursor: { activityId: current.id, createdAt: current.createdAt },
      },
    },
  };
  const page = {
    snapshotSequence: 8,
    history: { totalMessageCount: 0, olderCursor: null, olderActivityCursor: null },
    thread: makeReadModelThread({ activities }),
  };
  const next = mergeThreadHistoryPage(
    state,
    page,
    null,
    state.threadHistoryById[thread.id]!.olderActivityCursor,
  );
  expect(getThreadFromState(next, thread.id)?.activities).toHaveLength(2105);
});

it("does not rearm an exhausted message cursor while activities still page", () => {
  const thread = makeThread();
  const activityCursor = {
    activityId: EventId.makeUnsafe("a-5"),
    createdAt: "2026-10-10T10:00:00.000Z",
  };
  const state = {
    ...makeState(thread),
    threadHistoryById: {
      [thread.id]: {
        totalMessageCount: 205,
        totalActivityCount: 305,
        olderCursor: null,
        olderActivityCursor: activityCursor,
        revisionSequence: 0,
      },
    },
  };
  const page = {
    snapshotSequence: 20,
    thread: makeReadModelThread({}),
    history: {
      totalMessageCount: 205,
      totalActivityCount: 305,
      olderCursor: {
        messageId: MessageId.makeUnsafe("m-105"),
        sequence: 106,
        createdAt: activityCursor.createdAt,
      },
      olderActivityCursor: null,
      revisionSequence: 0,
    },
  };
  const next = mergeThreadHistoryPage(state, page, null, activityCursor);
  expect(next.threadHistoryById?.[thread.id]?.olderCursor).toBeNull();
});

it("does not rearm an exhausted activity cursor while messages still page", () => {
  const thread = makeThread();
  const messageCursor = {
    messageId: MessageId.makeUnsafe("m-5"),
    sequence: 6,
    createdAt: "2026-10-10T10:00:00.000Z",
  };
  const state = {
    ...makeState(thread),
    threadHistoryById: {
      [thread.id]: {
        totalMessageCount: 305,
        totalActivityCount: 205,
        olderCursor: messageCursor,
        olderActivityCursor: null,
        revisionSequence: 0,
      },
    },
  };
  const page = {
    snapshotSequence: 20,
    thread: makeReadModelThread({}),
    history: {
      totalMessageCount: 305,
      totalActivityCount: 205,
      olderCursor: null,
      olderActivityCursor: {
        activityId: EventId.makeUnsafe("a-105"),
        createdAt: messageCursor.createdAt,
      },
      revisionSequence: 0,
    },
  };
  const next = mergeThreadHistoryPage(state, page, messageCursor, null);
  expect(next.threadHistoryById?.[thread.id]?.olderActivityCursor).toBeNull();
});

it("removes loaded rows of rolled-back turns when the target message was outside the window", () => {
  const stale = {
    id: MessageId.makeUnsafe("removed-current"),
    turnId: TurnId.makeUnsafe("removed-turn"),
    role: "assistant" as const,
    text: "removed",
    streaming: false,
    createdAt: "2026-10-10T10:00:00.000Z",
  };
  const thread = makeThread({ messages: [stale] });
  const cursor = { messageId: stale.id, createdAt: stale.createdAt, sequence: 10 };
  const state = {
    ...makeState(thread),
    threadHistoryById: {
      [thread.id]: {
        totalMessageCount: 205,
        olderCursor: cursor,
        olderActivityCursor: null,
        revisionSequence: 0,
      },
    },
    threadDetailSyncById: { [thread.id]: "synced" as const },
    threadDetailAppliedSequenceById: { [thread.id]: 20 },
  };
  const event = {
    ...makeDomainEvent("thread.conversation-rolled-back", {
      threadId: thread.id,
      messageId: MessageId.makeUnsafe("unloaded-target"),
      numTurns: 100,
      removedTurnIds: [stale.turnId],
    }),
    sequence: 24,
  };
  const rolledBack = applyOrchestrationEventsHotPath(state, [event]);
  expect(getThreadFromState(rolledBack, thread.id)?.messages).toEqual([]);
});

it("clears an unknown rollback suffix even when an older server omits removed turn IDs", () => {
  const stale = {
    id: MessageId.makeUnsafe("removed-turnless"),
    role: "assistant" as const,
    text: "removed",
    streaming: false,
    createdAt: cursor.createdAt,
  };
  const thread = makeThread({ messages: [stale] });
  const state = {
    ...makeState(thread),
    threadHistoryById: {
      [thread.id]: {
        totalMessageCount: 205,
        olderCursor: cursor,
        revisionSequence: 0,
      },
    },
  };
  const event = makeDomainEvent(
    "thread.conversation-rolled-back",
    {
      threadId: thread.id,
      messageId: MessageId.makeUnsafe("older-unloaded-target"),
      numTurns: 100,
    },
    { sequence: 24 },
  );
  const next = applyOrchestrationEventsHotPath(state, [event]);
  expect(getThreadFromState(next, thread.id)?.messages).toEqual([]);
});

it("does not preserve removed rows after missing-target rollback and a same-count authoritative snapshot", () => {
  const stale = {
    id: MessageId.makeUnsafe("removed-current"),
    turnId: TurnId.makeUnsafe("removed-turn"),
    role: "assistant" as const,
    text: "removed",
    streaming: false,
    createdAt: "2026-10-10T10:00:00.000Z",
  };
  const thread = makeThread({ messages: [stale] });
  const cursor = { messageId: stale.id, createdAt: stale.createdAt, sequence: 10 };
  const state = {
    ...makeState(thread),
    threadHistoryById: {
      [thread.id]: {
        totalMessageCount: 205,
        olderCursor: cursor,
        olderActivityCursor: null,
        revisionSequence: 0,
      },
    },
    threadDetailSyncById: { [thread.id]: "synced" as const },
    threadDetailAppliedSequenceById: { [thread.id]: 20 },
  };
  const event = {
    ...makeDomainEvent("thread.conversation-rolled-back", {
      threadId: thread.id,
      messageId: MessageId.makeUnsafe("unloaded-target"),
      numTurns: 100,
      removedTurnIds: [stale.turnId],
    }),
    sequence: 24,
  };
  const rolledBack = applyOrchestrationEventsHotPath(state, [event]);
  const newMessage = {
    ...stale,
    id: MessageId.makeUnsafe("new-current"),
    turnId: TurnId.makeUnsafe("new-turn"),
    text: "new",
    source: "native" as const,
    updatedAt: stale.createdAt,
  };
  const snapshot = syncServerThreadDetailHotPath(
    rolledBack,
    makeReadModelThread({ messages: [newMessage] }),
    25,
    {
      totalMessageCount: 205,
      olderCursor: { ...cursor, messageId: newMessage.id },
      olderActivityCursor: null,
      revisionSequence: 24,
    },
  );
  expect(getThreadFromState(snapshot, thread.id)?.messages.map((m) => m.id)).toEqual([
    newMessage.id,
  ]);
});
