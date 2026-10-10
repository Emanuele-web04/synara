import { describe, expect, it } from "vitest";
import { EventId, MessageId } from "@synara/contracts";
import { makeReadModelThread, makeState, makeThread } from "./storeTestFixtures";
import { getThreadFromState } from "./threadDerivation";
import {
  mergeThreadHistoryPage,
  restoreCachedThreadDetail,
  syncServerThreadDetailHotPath,
  markThreadDetailSyncFailedInClientState,
} from "./storeProjection";

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
