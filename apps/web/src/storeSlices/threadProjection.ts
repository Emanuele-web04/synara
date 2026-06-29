// FILE: storeSlices/threadProjection.ts
// Purpose: Write normalized threads into AppState's per-thread projection slices (shell/session/
//   turn-state/message/activity/proposed-plan/turn-diff records) with reference-stable merges,
//   and remove thread/project state. Owns the frozen EMPTY_* sentinels selectors read through.
// Layer: AppState transforms consumed by store.ts reducers; AppState is a type-only store import.
// Exports: EMPTY_* sentinels, writeThreadState/writeThreadShellProjection, removeThread/ProjectState,
//   commitThreadProjection, retainThreadScopedRecord, ensureThreadRegistered.

import {
  type MessageId,
  type OrchestrationProviderItem,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import type { AppState } from "../store";
import {
  type ChatMessage,
  type Project,
  type Thread,
  type ThreadSession,
  type ThreadShell,
  type ThreadTurnState,
} from "../types";
import { getThreadFromState } from "../threadDerivation";
import { buildActivitySlice } from "./threadActivities";
import { buildMessageSlice } from "./threadMessages";
import { buildProviderItemSlice } from "./threadProviderItems";
import { buildProposedPlanSlice, sourceProposedPlansEqual } from "./threadProposedPlans";
import { buildSidebarThreadSummary } from "./sidebarSummaries";
import {
  threadSessionsEqual,
  threadShellsEqual,
  toThreadShell,
  toThreadTurnState,
} from "./threadShell";

// Stable empty reference for `threadIds` fallbacks. Consumers must read through
// this (never an inline `?? []`) so `useSyncExternalStore` selectors keep a
// stable snapshot and cannot trigger an infinite re-render (React error #185).
// Frozen so a consumer can never accidentally mutate the shared empty array.
export const EMPTY_THREAD_IDS: ThreadId[] = [];
Object.freeze(EMPTY_THREAD_IDS);
export const EMPTY_THREAD_SHELL_BY_ID: Record<ThreadId, ThreadShell> = {};
export const EMPTY_THREAD_SESSION_BY_ID: Record<ThreadId, ThreadSession | null> = {};
export const EMPTY_THREAD_TURN_STATE_BY_ID: Record<ThreadId, ThreadTurnState> = {};
export const EMPTY_MESSAGE_IDS_BY_THREAD: Record<ThreadId, MessageId[]> = {};
export const EMPTY_MESSAGE_BY_THREAD: Record<ThreadId, Record<MessageId, ChatMessage>> = {};
export const EMPTY_ACTIVITY_IDS_BY_THREAD: Record<ThreadId, string[]> = {};
export const EMPTY_ACTIVITY_BY_THREAD: Record<
  ThreadId,
  Record<string, Thread["activities"][number]>
> = {};
export const EMPTY_PROVIDER_ITEM_IDS_BY_THREAD: Record<ThreadId, string[]> = {};
export const EMPTY_PROVIDER_ITEM_BY_THREAD: Record<
  ThreadId,
  Record<string, OrchestrationProviderItem>
> = {};
export const EMPTY_PROPOSED_PLAN_IDS_BY_THREAD: Record<ThreadId, string[]> = {};
export const EMPTY_PROPOSED_PLAN_BY_THREAD: Record<
  ThreadId,
  Record<string, Thread["proposedPlans"][number]>
> = {};
export const EMPTY_TURN_DIFF_IDS_BY_THREAD: Record<ThreadId, TurnId[]> = {};
export const EMPTY_TURN_DIFF_BY_THREAD: Record<
  ThreadId,
  Record<TurnId, Thread["turnDiffSummaries"][number]>
> = {};

function updateThread(
  threads: Thread[],
  threadId: ThreadId,
  updater: (t: Thread) => Thread,
): Thread[] {
  let changed = false;
  const next = threads.map((t) => {
    if (t.id !== threadId) return t;
    const updated = updater(t);
    if (updated !== t) changed = true;
    return updated;
  });
  return changed ? next : threads;
}

function latestTurnsEqual(left: Thread["latestTurn"], right: Thread["latestTurn"]): boolean {
  if (left === right) return true;
  if (left == null || right == null) return false;
  return (
    left.turnId === right.turnId &&
    left.state === right.state &&
    left.requestedAt === right.requestedAt &&
    left.startedAt === right.startedAt &&
    left.completedAt === right.completedAt &&
    left.assistantMessageId === right.assistantMessageId &&
    sourceProposedPlansEqual(left.sourceProposedPlan, right.sourceProposedPlan)
  );
}

function threadTurnStatesEqual(left: ThreadTurnState | undefined, right: ThreadTurnState): boolean {
  return (
    left !== undefined &&
    latestTurnsEqual(left.latestTurn, right.latestTurn) &&
    sourceProposedPlansEqual(left.pendingSourceProposedPlan, right.pendingSourceProposedPlan)
  );
}

function buildTurnDiffSlice(thread: Thread): {
  ids: TurnId[];
  byId: Record<TurnId, Thread["turnDiffSummaries"][number]>;
} {
  return {
    ids: thread.turnDiffSummaries.map((summary) => summary.turnId),
    byId: Object.fromEntries(
      thread.turnDiffSummaries.map((summary) => [summary.turnId, summary] as const),
    ) as Record<TurnId, Thread["turnDiffSummaries"][number]>,
  };
}

export function ensureThreadRegistered(state: AppState, threadId: ThreadId): AppState {
  const threadIds = state.threadIds ?? EMPTY_THREAD_IDS;
  if (threadIds.includes(threadId)) {
    return state;
  }
  return {
    ...state,
    threadIds: [...threadIds, threadId],
  };
}

export function retainThreadScopedRecord<T>(
  record: Record<ThreadId, T> | undefined,
  nextThreadIds: ReadonlySet<ThreadId>,
): Record<ThreadId, T> {
  if (!record) {
    return {};
  }
  let changed = false;
  const nextRecord: Record<ThreadId, T> = {};
  for (const [threadId, value] of Object.entries(record) as [ThreadId, T][]) {
    if (!nextThreadIds.has(threadId)) {
      changed = true;
      continue;
    }
    nextRecord[threadId] = value;
  }
  return changed ? nextRecord : record;
}

export function writeThreadShellProjection(
  state: AppState,
  nextThread: {
    shell: ThreadShell;
    session: ThreadSession | null;
    turnState: ThreadTurnState;
  },
): AppState {
  const previousShell = state.threadShellById?.[nextThread.shell.id];
  let nextState = ensureThreadRegistered(state, nextThread.shell.id);

  if (!threadShellsEqual(previousShell, nextThread.shell)) {
    nextState = {
      ...nextState,
      threadShellById: {
        ...(nextState.threadShellById ?? EMPTY_THREAD_SHELL_BY_ID),
        [nextThread.shell.id]: nextThread.shell,
      },
    };
  }

  if (
    !threadSessionsEqual(
      (nextState.threadSessionById ?? EMPTY_THREAD_SESSION_BY_ID)[nextThread.shell.id] ?? null,
      nextThread.session,
    )
  ) {
    nextState = {
      ...nextState,
      threadSessionById: {
        ...(nextState.threadSessionById ?? EMPTY_THREAD_SESSION_BY_ID),
        [nextThread.shell.id]: nextThread.session,
      },
    };
  }

  if (
    !threadTurnStatesEqual(
      (nextState.threadTurnStateById ?? EMPTY_THREAD_TURN_STATE_BY_ID)[nextThread.shell.id],
      nextThread.turnState,
    )
  ) {
    nextState = {
      ...nextState,
      threadTurnStateById: {
        ...(nextState.threadTurnStateById ?? EMPTY_THREAD_TURN_STATE_BY_ID),
        [nextThread.shell.id]: nextThread.turnState,
      },
    };
  }

  return nextState;
}

// Detail writes keep the active thread slices current, but sidebar summaries stay
// shell-owned so active transcript churn does not fan out into the navigation tree.
export function writeThreadState(
  state: AppState,
  nextThread: Thread,
  previousThread?: Thread,
): AppState {
  const nextShell = toThreadShell(nextThread);
  const nextTurnState = toThreadTurnState(nextThread);
  const previousShell = state.threadShellById?.[nextThread.id];
  const previousTurnState = state.threadTurnStateById?.[nextThread.id];

  let nextState = ensureThreadRegistered(state, nextThread.id);

  if (!threadShellsEqual(previousShell, nextShell)) {
    nextState = {
      ...nextState,
      threadShellById: {
        ...(nextState.threadShellById ?? EMPTY_THREAD_SHELL_BY_ID),
        [nextThread.id]: nextShell,
      },
    };
  }

  if (!threadSessionsEqual(previousThread?.session ?? null, nextThread.session)) {
    nextState = {
      ...nextState,
      threadSessionById: {
        ...(nextState.threadSessionById ?? EMPTY_THREAD_SESSION_BY_ID),
        [nextThread.id]: nextThread.session,
      },
    };
  }

  if (!threadTurnStatesEqual(previousTurnState, nextTurnState)) {
    nextState = {
      ...nextState,
      threadTurnStateById: {
        ...(nextState.threadTurnStateById ?? EMPTY_THREAD_TURN_STATE_BY_ID),
        [nextThread.id]: nextTurnState,
      },
    };
  }

  if (previousThread?.messages !== nextThread.messages) {
    const nextMessageSlice = buildMessageSlice(nextThread);
    nextState = {
      ...nextState,
      messageIdsByThreadId: {
        ...(nextState.messageIdsByThreadId ?? EMPTY_MESSAGE_IDS_BY_THREAD),
        [nextThread.id]: nextMessageSlice.ids,
      },
      messageByThreadId: {
        ...(nextState.messageByThreadId ?? EMPTY_MESSAGE_BY_THREAD),
        [nextThread.id]: nextMessageSlice.byId,
      },
    };
  }

  if (previousThread?.activities !== nextThread.activities) {
    const nextActivitySlice = buildActivitySlice(nextThread);
    nextState = {
      ...nextState,
      activityIdsByThreadId: {
        ...(nextState.activityIdsByThreadId ?? EMPTY_ACTIVITY_IDS_BY_THREAD),
        [nextThread.id]: nextActivitySlice.ids,
      },
      activityByThreadId: {
        ...(nextState.activityByThreadId ?? EMPTY_ACTIVITY_BY_THREAD),
        [nextThread.id]: nextActivitySlice.byId,
      },
    };
  }

  if (
    previousThread?.providerItems !== nextThread.providerItems ||
    (nextState.providerItemIdsByThreadId ?? EMPTY_PROVIDER_ITEM_IDS_BY_THREAD)[nextThread.id] ===
      undefined
  ) {
    const nextProviderItemSlice = buildProviderItemSlice(nextThread);
    nextState = {
      ...nextState,
      providerItemIdsByThreadId: {
        ...(nextState.providerItemIdsByThreadId ?? EMPTY_PROVIDER_ITEM_IDS_BY_THREAD),
        [nextThread.id]: nextProviderItemSlice.ids,
      },
      providerItemByThreadId: {
        ...(nextState.providerItemByThreadId ?? EMPTY_PROVIDER_ITEM_BY_THREAD),
        [nextThread.id]: nextProviderItemSlice.byId,
      },
    };
  }

  if (previousThread?.proposedPlans !== nextThread.proposedPlans) {
    const nextProposedPlanSlice = buildProposedPlanSlice(nextThread);
    nextState = {
      ...nextState,
      proposedPlanIdsByThreadId: {
        ...(nextState.proposedPlanIdsByThreadId ?? EMPTY_PROPOSED_PLAN_IDS_BY_THREAD),
        [nextThread.id]: nextProposedPlanSlice.ids,
      },
      proposedPlanByThreadId: {
        ...(nextState.proposedPlanByThreadId ?? EMPTY_PROPOSED_PLAN_BY_THREAD),
        [nextThread.id]: nextProposedPlanSlice.byId,
      },
    };
  }

  if (previousThread?.turnDiffSummaries !== nextThread.turnDiffSummaries) {
    const nextTurnDiffSlice = buildTurnDiffSlice(nextThread);
    nextState = {
      ...nextState,
      turnDiffIdsByThreadId: {
        ...(nextState.turnDiffIdsByThreadId ?? EMPTY_TURN_DIFF_IDS_BY_THREAD),
        [nextThread.id]: nextTurnDiffSlice.ids,
      },
      turnDiffSummaryByThreadId: {
        ...(nextState.turnDiffSummaryByThreadId ?? EMPTY_TURN_DIFF_BY_THREAD),
        [nextThread.id]: nextTurnDiffSlice.byId,
      },
    };
  }

  return nextState;
}

export function removeThreadState(state: AppState, threadId: ThreadId): AppState {
  const { [threadId]: _removedShell, ...threadShellById } =
    state.threadShellById ?? EMPTY_THREAD_SHELL_BY_ID;
  const { [threadId]: _removedSession, ...threadSessionById } =
    state.threadSessionById ?? EMPTY_THREAD_SESSION_BY_ID;
  const { [threadId]: _removedTurnState, ...threadTurnStateById } =
    state.threadTurnStateById ?? EMPTY_THREAD_TURN_STATE_BY_ID;
  const { [threadId]: _removedMessageIds, ...messageIdsByThreadId } =
    state.messageIdsByThreadId ?? EMPTY_MESSAGE_IDS_BY_THREAD;
  const { [threadId]: _removedMessages, ...messageByThreadId } =
    state.messageByThreadId ?? EMPTY_MESSAGE_BY_THREAD;
  const { [threadId]: _removedActivityIds, ...activityIdsByThreadId } =
    state.activityIdsByThreadId ?? EMPTY_ACTIVITY_IDS_BY_THREAD;
  const { [threadId]: _removedActivities, ...activityByThreadId } =
    state.activityByThreadId ?? EMPTY_ACTIVITY_BY_THREAD;
  const { [threadId]: _removedProviderItemIds, ...providerItemIdsByThreadId } =
    state.providerItemIdsByThreadId ?? EMPTY_PROVIDER_ITEM_IDS_BY_THREAD;
  const { [threadId]: _removedProviderItems, ...providerItemByThreadId } =
    state.providerItemByThreadId ?? EMPTY_PROVIDER_ITEM_BY_THREAD;
  const { [threadId]: _removedPlanIds, ...proposedPlanIdsByThreadId } =
    state.proposedPlanIdsByThreadId ?? EMPTY_PROPOSED_PLAN_IDS_BY_THREAD;
  const { [threadId]: _removedPlans, ...proposedPlanByThreadId } =
    state.proposedPlanByThreadId ?? EMPTY_PROPOSED_PLAN_BY_THREAD;
  const { [threadId]: _removedDiffIds, ...turnDiffIdsByThreadId } =
    state.turnDiffIdsByThreadId ?? EMPTY_TURN_DIFF_IDS_BY_THREAD;
  const { [threadId]: _removedDiffs, ...turnDiffSummaryByThreadId } =
    state.turnDiffSummaryByThreadId ?? EMPTY_TURN_DIFF_BY_THREAD;
  const { [threadId]: _removedSummary, ...sidebarThreadSummaryById } =
    state.sidebarThreadSummaryById;
  const nextThreadIds = (state.threadIds ?? EMPTY_THREAD_IDS).filter((id) => id !== threadId);
  const nextThreads = state.threads.filter((thread) => thread.id !== threadId);

  if (
    nextThreadIds === state.threadIds &&
    nextThreads === state.threads &&
    sidebarThreadSummaryById === state.sidebarThreadSummaryById
  ) {
    return state;
  }

  return {
    ...state,
    threadIds: nextThreadIds,
    threadShellById,
    threadSessionById,
    threadTurnStateById,
    messageIdsByThreadId,
    messageByThreadId,
    activityIdsByThreadId,
    activityByThreadId,
    providerItemIdsByThreadId,
    providerItemByThreadId,
    proposedPlanIdsByThreadId,
    proposedPlanByThreadId,
    turnDiffIdsByThreadId,
    turnDiffSummaryByThreadId,
    sidebarThreadSummaryById,
    threads: nextThreads,
  };
}

// Drop a project and any thread-scoped state that still points at it.
export function removeProjectState(state: AppState, projectId: Project["id"]): AppState {
  const threadIds = new Set<ThreadId>();
  for (const thread of state.threads) {
    if (thread.projectId === projectId) {
      threadIds.add(thread.id);
    }
  }
  for (const shell of Object.values(state.threadShellById ?? EMPTY_THREAD_SHELL_BY_ID)) {
    if (shell.projectId === projectId) {
      threadIds.add(shell.id);
    }
  }

  const nextProjects = state.projects.filter((project) => project.id !== projectId);
  const nextState = [...threadIds].reduce((currentState, threadId) => {
    return removeThreadState(currentState, threadId);
  }, state);

  if (nextProjects === state.projects && nextState === state) {
    return state;
  }

  return nextProjects === nextState.projects
    ? nextState
    : {
        ...nextState,
        projects: nextProjects,
      };
}

export function commitThreadProjection(
  state: AppState,
  threadId: ThreadId,
  options?: {
    updateThreadArray?: boolean;
    updateSidebarSummary?: boolean;
  },
): AppState {
  const nextThread = getThreadFromState(state, threadId);
  const previousThread = state.threads.find((thread) => thread.id === threadId);
  if (!nextThread) {
    return state;
  }

  // Let hot-path detail syncs skip array churn without forcing sidebar ownership
  // back onto the thread-detail path.
  const shouldUpdateThreadArray = options?.updateThreadArray ?? true;
  const shouldUpdateSidebarSummary = options?.updateSidebarSummary ?? true;
  const threadExists = previousThread !== undefined;
  const threads = shouldUpdateThreadArray
    ? threadExists
      ? updateThread(state.threads, threadId, (thread) =>
          nextThread === thread ? thread : nextThread,
        )
      : [...state.threads, nextThread]
    : state.threads;

  const previousSummary = state.sidebarThreadSummaryById[threadId];
  const nextSummary =
    shouldUpdateSidebarSummary || previousSummary === undefined
      ? buildSidebarThreadSummary(nextThread, previousSummary)
      : previousSummary;

  if (threads === state.threads && nextSummary === previousSummary) {
    return state;
  }

  return {
    ...state,
    threads,
    sidebarThreadSummaryById:
      nextSummary === previousSummary || nextSummary === undefined
        ? state.sidebarThreadSummaryById
        : {
            ...state.sidebarThreadSummaryById,
            [threadId]: nextSummary,
          },
  };
}
