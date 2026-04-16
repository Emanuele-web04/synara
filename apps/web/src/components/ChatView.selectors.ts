// FILE: ChatView.selectors.ts
// Purpose: Keep ChatView's thread-scoped selectors off the component hot path and out of the render file.
// Exports: lineage/work-log selector factories used by ChatView.

import {
  type MessageId,
  ThreadId,
  type ThreadId as ThreadIdType,
  type TurnId,
} from "@t3tools/contracts";

import type { AppState } from "../store";
import { getThreadFromState } from "../threadDerivation";
import type {
  ChatMessage,
  ProposedPlan,
  Thread,
  ThreadSession,
  ThreadShell,
  ThreadTurnState,
  TurnDiffSummary,
} from "../types";
import type { WorkLogEntry } from "../session-logic";

type ThreadSliceRefs = {
  shell: ThreadShell | undefined;
  session: ThreadSession | null | undefined;
  turnState: ThreadTurnState | undefined;
  messageIds: readonly MessageId[] | undefined;
  messages: Record<MessageId, ChatMessage> | undefined;
  activityIds: readonly string[] | undefined;
  activities: Record<string, Thread["activities"][number]> | undefined;
  proposedPlanIds: readonly string[] | undefined;
  proposedPlans: Record<string, ProposedPlan> | undefined;
  turnDiffIds: readonly TurnId[] | undefined;
  turnDiffs: Record<TurnId, TurnDiffSummary> | undefined;
};

function collectThreadSliceRefs(state: AppState, threadId: ThreadIdType): ThreadSliceRefs {
  return {
    shell: state.threadShellById?.[threadId],
    session: state.threadSessionById?.[threadId],
    turnState: state.threadTurnStateById?.[threadId],
    messageIds: state.messageIdsByThreadId?.[threadId],
    messages: state.messageByThreadId?.[threadId],
    activityIds: state.activityIdsByThreadId?.[threadId],
    activities: state.activityByThreadId?.[threadId],
    proposedPlanIds: state.proposedPlanIdsByThreadId?.[threadId],
    proposedPlans: state.proposedPlanByThreadId?.[threadId],
    turnDiffIds: state.turnDiffIdsByThreadId?.[threadId],
    turnDiffs: state.turnDiffSummaryByThreadId?.[threadId],
  };
}

function threadSliceRefsEqual(left: ThreadSliceRefs | undefined, right: ThreadSliceRefs): boolean {
  return (
    left !== undefined &&
    left.shell === right.shell &&
    left.session === right.session &&
    left.turnState === right.turnState &&
    left.messageIds === right.messageIds &&
    left.messages === right.messages &&
    left.activityIds === right.activityIds &&
    left.activities === right.activities &&
    left.proposedPlanIds === right.proposedPlanIds &&
    left.proposedPlans === right.proposedPlans &&
    left.turnDiffIds === right.turnDiffIds &&
    left.turnDiffs === right.turnDiffs
  );
}

function shallowEqualThreadIds(
  left: ReadonlyArray<ThreadIdType>,
  right: ReadonlyArray<ThreadIdType>,
): boolean {
  return left.length === right.length && left.every((threadId, index) => threadId === right[index]);
}

function shallowEqualThreads(left: ReadonlyArray<Thread>, right: ReadonlyArray<Thread>): boolean {
  return left.length === right.length && left.every((thread, index) => thread === right[index]);
}

function buildThreadSelectionResult(
  state: AppState,
  selectedThreadIds: ReadonlyArray<ThreadIdType>,
): Thread[] {
  return selectedThreadIds.flatMap((threadId) => {
    const thread = getThreadFromState(state, threadId);
    return thread ? [thread] : [];
  });
}

export function localSubagentThreadId(
  parentThreadId: ThreadIdType,
  providerThreadId: string,
): ThreadIdType {
  return ThreadId.makeUnsafe(`subagent:${parentThreadId}:${providerThreadId}`);
}

export function createRelevantWorkLogThreadsSelector(input: {
  workEntries: ReadonlyArray<WorkLogEntry>;
  parentThreadId: ThreadIdType | null;
  enabled: boolean;
}) {
  const directThreadIds = new Set<ThreadIdType>();
  const agentIds = new Set<string>();

  if (input.parentThreadId) {
    directThreadIds.add(input.parentThreadId);
  }

  for (const entry of input.workEntries) {
    for (const subagent of entry.subagents ?? []) {
      const directThreadId = subagent.resolvedThreadId ?? subagent.threadId;
      if (directThreadId) {
        directThreadIds.add(ThreadId.makeUnsafe(directThreadId));
      }

      const providerThreadId = subagent.providerThreadId ?? subagent.threadId;
      if (input.parentThreadId && providerThreadId) {
        directThreadIds.add(localSubagentThreadId(input.parentThreadId, providerThreadId));
      }

      if (subagent.agentId) {
        agentIds.add(subagent.agentId);
      }
    }
  }

  let previousThreadIds: ReadonlyArray<ThreadIdType> | undefined;
  let previousThreadShellById: AppState["threadShellById"] | undefined;
  let previousSelectedThreadIds: ThreadIdType[] = [];
  let previousSliceRefs = new Map<ThreadIdType, ThreadSliceRefs>();
  let previousResult: Thread[] = [];

  return (state: AppState): Thread[] => {
    if (!input.enabled) {
      if (previousResult.length === 0) {
        return previousResult;
      }
      previousThreadIds = state.threadIds;
      previousThreadShellById = state.threadShellById;
      previousSelectedThreadIds = [];
      previousSliceRefs = new Map();
      previousResult = [];
      return previousResult;
    }

    const selectedThreadIds = new Set<ThreadIdType>();
    const threadIds: readonly ThreadIdType[] = state.threadIds ?? [];
    const threadShellById: Record<ThreadIdType, ThreadShell> = state.threadShellById ?? {};

    for (const threadId of threadIds) {
      const shell = threadShellById[threadId];
      if (!shell) {
        continue;
      }
      if (directThreadIds.has(shell.id)) {
        selectedThreadIds.add(shell.id);
      }
      if (input.parentThreadId && shell.parentThreadId === input.parentThreadId) {
        selectedThreadIds.add(shell.id);
      }
      if (shell.subagentAgentId && agentIds.has(shell.subagentAgentId)) {
        selectedThreadIds.add(shell.id);
      }
    }

    const pendingAncestorIds = [...selectedThreadIds];
    while (pendingAncestorIds.length > 0) {
      const threadId = pendingAncestorIds.pop();
      if (!threadId) {
        continue;
      }
      const parentThreadId = threadShellById[threadId]?.parentThreadId ?? null;
      if (parentThreadId && !selectedThreadIds.has(parentThreadId)) {
        selectedThreadIds.add(parentThreadId);
        pendingAncestorIds.push(parentThreadId);
      }
    }

    const nextSelectedThreadIds = threadIds.filter((threadId) => selectedThreadIds.has(threadId));
    const selectedIdsChanged =
      previousThreadIds !== threadIds ||
      previousThreadShellById !== threadShellById ||
      !shallowEqualThreadIds(previousSelectedThreadIds, nextSelectedThreadIds);
    const nextSliceRefs = new Map<ThreadIdType, ThreadSliceRefs>();
    let sliceRefsChanged = selectedIdsChanged;

    for (const threadId of nextSelectedThreadIds) {
      const nextRefs = collectThreadSliceRefs(state, threadId);
      nextSliceRefs.set(threadId, nextRefs);
      if (!sliceRefsChanged && !threadSliceRefsEqual(previousSliceRefs.get(threadId), nextRefs)) {
        sliceRefsChanged = true;
      }
    }

    if (!selectedIdsChanged && !sliceRefsChanged) {
      return previousResult;
    }

    previousThreadIds = threadIds;
    previousThreadShellById = threadShellById;
    previousSelectedThreadIds = nextSelectedThreadIds;
    previousSliceRefs = nextSliceRefs;

    const nextResult = buildThreadSelectionResult(state, nextSelectedThreadIds);
    if (shallowEqualThreads(previousResult, nextResult)) {
      return previousResult;
    }

    previousResult = nextResult;
    return previousResult;
  };
}

export function createThreadLineageSelector(threadId: ThreadIdType | null) {
  let previousThreadIds: ReadonlyArray<ThreadIdType> | undefined;
  let previousThreadShellById: AppState["threadShellById"] | undefined;
  let previousSelectedThreadIds: ThreadIdType[] = [];
  let previousSliceRefs = new Map<ThreadIdType, ThreadSliceRefs>();
  let previousResult: Thread[] = [];

  return (state: AppState): Thread[] => {
    if (!threadId) {
      if (previousResult.length === 0) {
        return previousResult;
      }
      previousThreadIds = state.threadIds;
      previousThreadShellById = state.threadShellById;
      previousSelectedThreadIds = [];
      previousSliceRefs = new Map();
      previousResult = [];
      return previousResult;
    }

    const threadIds: readonly ThreadIdType[] = state.threadIds ?? [];
    const threadShellById: Record<ThreadIdType, ThreadShell> = state.threadShellById ?? {};
    const selectedThreadIds: ThreadIdType[] = [];
    const visitedThreadIds = new Set<ThreadIdType>();
    let currentThreadId: ThreadIdType | null = threadId;

    while (currentThreadId) {
      const thread: ThreadShell | undefined = threadShellById[currentThreadId];
      if (!thread || visitedThreadIds.has(thread.id)) {
        break;
      }
      selectedThreadIds.unshift(thread.id);
      visitedThreadIds.add(thread.id);
      currentThreadId = thread.parentThreadId ?? null;
    }

    const selectedIdsChanged =
      previousThreadIds !== threadIds ||
      previousThreadShellById !== threadShellById ||
      !shallowEqualThreadIds(previousSelectedThreadIds, selectedThreadIds);
    const nextSliceRefs = new Map<ThreadIdType, ThreadSliceRefs>();
    let sliceRefsChanged = selectedIdsChanged;

    for (const selectedThreadId of selectedThreadIds) {
      const nextRefs = collectThreadSliceRefs(state, selectedThreadId);
      nextSliceRefs.set(selectedThreadId, nextRefs);
      if (
        !sliceRefsChanged &&
        !threadSliceRefsEqual(previousSliceRefs.get(selectedThreadId), nextRefs)
      ) {
        sliceRefsChanged = true;
      }
    }

    if (!selectedIdsChanged && !sliceRefsChanged) {
      return previousResult;
    }

    previousThreadIds = threadIds;
    previousThreadShellById = threadShellById;
    previousSelectedThreadIds = selectedThreadIds;
    previousSliceRefs = nextSliceRefs;

    const nextResult = buildThreadSelectionResult(state, selectedThreadIds);
    if (shallowEqualThreads(previousResult, nextResult)) {
      return previousResult;
    }

    previousResult = nextResult;
    return previousResult;
  };
}
