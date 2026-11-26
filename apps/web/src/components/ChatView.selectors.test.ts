import { EventId, MessageId, ThreadId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { AppState } from "../store";
import type { ChatMessage, Thread, ThreadSession, ThreadShell } from "../types";
import {
  createRunningChildThreadIdsSelector,
  createThreadLineageSelector,
} from "./ChatView.selectors";

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

  it("stays stable when a lineage shell only rewrites a field the lineage does not read", () => {
    const selectLineage = createThreadLineageSelector(childThreadId);
    const before = selectLineage(makeState());
    // What every streamed token does to the active thread's shell.
    const after = selectLineage(
      makeState({
        threadShellById: {
          ...threadShellById,
          [childThreadId]: {
            ...threadShellById[childThreadId]!,
            updatedAt: "2026-01-01T00:05:00.000Z",
          },
        },
      }),
    );
    expect(after).toBe(before);

    const renamed = selectLineage(
      makeState({
        threadShellById: {
          ...threadShellById,
          [childThreadId]: { ...threadShellById[childThreadId]!, title: "Renamed child" },
        },
      }),
    );
    expect(renamed).not.toBe(before);
    expect(renamed.at(-1)?.title).toBe("Renamed child");
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

describe("createRunningChildThreadIdsSelector", () => {
  const session = (status: ThreadSession["status"]) => ({ status }) as ThreadSession;
  const shell = (id: string, overrides: Partial<ThreadShell> = {}) =>
    ({ id: ThreadId.makeUnsafe(id), title: id, error: null, ...overrides }) as ThreadShell;
  const runningId = ThreadId.makeUnsafe("child-running");
  const settledId = ThreadId.makeUnsafe("child-settled");
  const archivedId = ThreadId.makeUnsafe("child-archived");
  const foreignId = ThreadId.makeUnsafe("child-foreign");
  const state = makeState({
    threadIds: [rootThreadId, runningId, settledId, archivedId, foreignId],
    threadShellById: {
      [rootThreadId]: rootShell,
      [runningId]: shell(runningId, { parentThreadId: rootThreadId }),
      [settledId]: shell(settledId, { parentThreadId: rootThreadId }),
      [archivedId]: shell(archivedId, {
        parentThreadId: rootThreadId,
        archivedAt: "2026-06-01T00:00:00.000Z",
      }),
      [foreignId]: shell(foreignId, { parentThreadId: unrelatedThreadId }),
    },
    threadSessionById: {
      [runningId]: session("running"),
      [settledId]: session("ready"),
      [archivedId]: session("running"),
      [foreignId]: session("running"),
    },
    threadTurnStateById: {},
  });

  it("keeps the parent's running, unarchived children with a stable identity", () => {
    const select = createRunningChildThreadIdsSelector(rootThreadId);
    const first = select(state);
    expect(first).toEqual([runningId]);
    expect(select({ ...state })).toBe(first);
    expect(
      select({
        ...state,
        threadSessionById: { ...state.threadSessionById, [settledId]: session("ready") },
      }),
    ).toBe(first);
  });

  it("selects only a nested launcher's children while preserving the root-wide view", () => {
    const nestedId = ThreadId.makeUnsafe("child-nested");
    const nestedState = {
      ...state,
      threadIds: [...(state.threadIds ?? []), nestedId],
      threadShellById: {
        ...state.threadShellById,
        [nestedId]: shell(nestedId, { parentThreadId: rootThreadId, sourceThreadId: runningId }),
      },
      threadSessionById: { ...state.threadSessionById, [nestedId]: session("running") },
    };
    const selectNested = createRunningChildThreadIdsSelector(rootThreadId, runningId);
    const first = selectNested(nestedState);
    expect(first).toEqual([nestedId]);
    expect(selectNested({ ...nestedState })).toBe(first);
    expect(createRunningChildThreadIdsSelector(rootThreadId)(nestedState)).toEqual([
      runningId,
      nestedId,
    ]);
  });

  it("selects nothing without a parent", () => {
    const select = createRunningChildThreadIdsSelector(null);
    expect(select(state)).toEqual([]);
    expect(select(state)).toBe(select({ ...state }));
  });
});
