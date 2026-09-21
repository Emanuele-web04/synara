import { OrchestrationThreadActivity, ThreadId, type TurnId } from "@synara/contracts";
import { useEffect, useMemo } from "react";
import {
  deriveWorkLogEntries,
  isLatestTurnSettled,
  omitRoutedSubagentWorkEntries,
} from "../../session-logic";
import { useStore } from "../../store";
import { createThreadSelector } from "../../storeSelectors";
import { retainThreadDetailSubscription } from "../../threadDetailSubscriptionRetention";
import type { Thread } from "../../types";
import { useWorkflowRunUiThreadState } from "../../workflowRunUiStore";
import { enrichSubagentWorkEntries, resolveComposerStripWorkLogEntries } from "../ChatView.logic";
import { createRelevantWorkLogThreadsSelector } from "../ChatView.selectors";
import { deriveComposerSubagentStripItems } from "./ComposerSubagentStrip.logic";
import { deriveWorkflowRunState, type WorkflowSubagentThreadRef } from "./WorkflowRunCard.logic";
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
interface ChatWorkLogInput {
  activeThread: Thread | undefined;
  latestTurnSettled: boolean;
  latestTurnLive: boolean;
}

export function useChatWorkLog({
  activeThread,
  latestTurnSettled,
  latestTurnLive,
}: ChatWorkLogInput) {
  const activeThreadId = activeThread?.id ?? null;
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const activeLatestTurnId = activeLatestTurn?.turnId ?? null;
  const activeLatestTurnStartedAt = activeLatestTurn?.startedAt ?? null;
  const activeLatestTurnState = activeLatestTurn?.state ?? null;
  const activeLatestTurnCompletedAt = activeLatestTurn?.completedAt ?? null;
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  // user messages intentionally have no turn id; assistant messages are the stable bridge for folding historical work into visible replies
  // memoized on purpose: an inline Set would change identity every render and cascade into the virtualized list, which resets in a loop on unstable data
  const workLogVisibleTurnIds = useMemo(() => {
    const turnIds = new Set<TurnId>();
    for (const message of activeThread?.messages ?? []) {
      if (message.turnId) {
        turnIds.add(message.turnId);
      }
    }
    if (activeLatestTurnId) {
      turnIds.add(activeLatestTurnId);
    }
    return turnIds;
  }, [activeLatestTurnId, activeThread?.messages]);
  const rawWorkLogEntries = useMemo(
    () =>
      deriveWorkLogEntries(threadActivities, activeLatestTurnId ?? undefined, {
        visibleTurnIds: workLogVisibleTurnIds,
        activeTurnId: latestTurnLive ? activeLatestTurnId : null,
        activeTurnStartedAt: activeLatestTurnStartedAt,
        latestTurnState: activeLatestTurnState,
        latestTurnCompletedAt: activeLatestTurnCompletedAt,
      }),
    [
      activeLatestTurnCompletedAt,
      activeLatestTurnId,
      activeLatestTurnStartedAt,
      activeLatestTurnState,
      latestTurnLive,
      threadActivities,
      workLogVisibleTurnIds,
    ],
  );
  const hasWorkLogSubagents = useMemo(
    () => rawWorkLogEntries.some((entry) => (entry.subagents?.length ?? 0) > 0),
    [rawWorkLogEntries],
  );
  const relevantWorkLogThreads = useStore(
    useMemo(
      () =>
        createRelevantWorkLogThreadsSelector({
          workEntries: rawWorkLogEntries,
          parentThreadId: activeThread?.id ?? null,
          enabled: hasWorkLogSubagents,
        }),
      [activeThread?.id, hasWorkLogSubagents, rawWorkLogEntries],
    ),
  );
  const enrichedWorkLogEntries = useMemo(
    () =>
      hasWorkLogSubagents
        ? enrichSubagentWorkEntries(
            rawWorkLogEntries,
            relevantWorkLogThreads,
            activeThread?.id ?? null,
          )
        : rawWorkLogEntries,
    [activeThread?.id, hasWorkLogSubagents, rawWorkLogEntries, relevantWorkLogThreads],
  );
  // subagents are presented by the composer strip; the transcript drops the routed fan-out rows while the enriched list still feeds strip derivations
  const workLogEntries = useMemo(
    () => omitRoutedSubagentWorkEntries(enrichedWorkLogEntries),
    [enrichedWorkLogEntries],
  );
  // the strip's liveness reads the child thread's own session and tail activities — retain a detail subscription while a subagent runs
  const liveSubagentThreadIdsKey = useMemo(() => {
    if (!hasWorkLogSubagents) {
      return "";
    }
    const threadIds = new Set<string>();
    for (const entry of enrichedWorkLogEntries) {
      for (const subagent of entry.subagents ?? []) {
        if (subagent.isActive && subagent.resolvedThreadId) {
          threadIds.add(subagent.resolvedThreadId);
        }
      }
    }
    return [...threadIds].toSorted().join("\n");
  }, [enrichedWorkLogEntries, hasWorkLogSubagents]);
  useEffect(() => {
    if (!liveSubagentThreadIdsKey) {
      return;
    }
    const releases = liveSubagentThreadIdsKey
      .split("\n")
      .map((threadId) => retainThreadDetailSubscription(ThreadId.makeUnsafe(threadId)));
    return () => {
      for (const release of releases) {
        release();
      }
    };
  }, [liveSubagentThreadIdsKey]);
  // native-CLI parity: while a subagent thread is open, the strip derives from the PARENT's activities so siblings and a way back stay visible
  const stripParentThreadId = activeThread?.parentThreadId ?? null;
  const stripParentThread = useStore(
    useMemo(() => createThreadSelector(stripParentThreadId), [stripParentThreadId]),
  );
  // deep links can land on a subagent thread before the parent has a detail subscription — retain one so the parent's activities hydrate
  useEffect(() => {
    if (!stripParentThreadId) {
      return;
    }
    return retainThreadDetailSubscription(stripParentThreadId);
  }, [stripParentThreadId]);
  const stripSourceThreadId = stripParentThread?.id ?? activeThread?.id ?? null;
  const stripSourceActivities = stripParentThread?.activities ?? threadActivities;
  const stripSourceLatestTurnId = stripParentThread
    ? (stripParentThread.latestTurn?.turnId ?? null)
    : (activeLatestTurn?.turnId ?? null);
  const stripSourceLatestTurnState = stripParentThread
    ? (stripParentThread.latestTurn?.state ?? null)
    : activeLatestTurnState;
  const stripSourceLatestTurnStartedAt = stripParentThread
    ? (stripParentThread.latestTurn?.startedAt ?? null)
    : activeLatestTurnStartedAt;
  const stripSourceLatestTurnCompletedAt = stripParentThread
    ? (stripParentThread.latestTurn?.completedAt ?? null)
    : activeLatestTurnCompletedAt;
  const stripVisibleTurnIds = useMemo(() => {
    if (!stripParentThread) {
      return workLogVisibleTurnIds;
    }
    const turnIds = new Set<TurnId>();
    for (const message of stripParentThread.messages) {
      if (message.turnId) {
        turnIds.add(message.turnId);
      }
    }
    if (stripParentThread.latestTurn?.turnId) {
      turnIds.add(stripParentThread.latestTurn.turnId);
    }
    return turnIds;
  }, [stripParentThread, workLogVisibleTurnIds]);
  const stripLiveTurnId = stripParentThread
    ? isLatestTurnSettled(stripParentThread.latestTurn, stripParentThread.session ?? null)
      ? null
      : (stripParentThread.latestTurn?.turnId ?? null)
    : latestTurnSettled
      ? null
      : (activeLatestTurn?.turnId ?? null);
  // reuse the top-level thread's already-derived source so every live activity doesn't scan the full history twice; subagent views derive from their distinct parent source
  const stripRawWorkLogEntries = useMemo(
    () =>
      resolveComposerStripWorkLogEntries({
        hasDistinctParentSource: stripParentThread !== undefined,
        activeWorkLogEntries: rawWorkLogEntries,
        deriveParentWorkLogEntries: () =>
          deriveWorkLogEntries(stripSourceActivities, stripSourceLatestTurnId ?? undefined, {
            visibleTurnIds: stripVisibleTurnIds,
            activeTurnId: stripLiveTurnId,
            activeTurnStartedAt: stripSourceLatestTurnStartedAt,
            latestTurnState: stripSourceLatestTurnState,
            latestTurnCompletedAt: stripSourceLatestTurnCompletedAt,
          }),
      }),
    [
      rawWorkLogEntries,
      stripLiveTurnId,
      stripParentThread,
      stripSourceActivities,
      stripSourceLatestTurnCompletedAt,
      stripSourceLatestTurnId,
      stripSourceLatestTurnStartedAt,
      stripSourceLatestTurnState,
      stripVisibleTurnIds,
    ],
  );
  const hasStripWorkLogSubagents = useMemo(
    () => stripRawWorkLogEntries.some((entry) => (entry.subagents?.length ?? 0) > 0),
    [stripRawWorkLogEntries],
  );
  const stripRelevantWorkLogThreads = useStore(
    useMemo(
      () =>
        createRelevantWorkLogThreadsSelector({
          workEntries: stripRawWorkLogEntries,
          parentThreadId: stripSourceThreadId,
          enabled: hasStripWorkLogSubagents,
        }),
      [stripSourceThreadId, hasStripWorkLogSubagents, stripRawWorkLogEntries],
    ),
  );
  const stripWorkLogEntries = useMemo(
    () =>
      hasStripWorkLogSubagents
        ? enrichSubagentWorkEntries(
            stripRawWorkLogEntries,
            stripRelevantWorkLogThreads,
            stripSourceThreadId,
          )
        : stripRawWorkLogEntries,
    [
      stripSourceThreadId,
      hasStripWorkLogSubagents,
      stripRawWorkLogEntries,
      stripRelevantWorkLogThreads,
    ],
  );

  // tool_use_ids the provider confirmed as backgrounded via task_updated patches (last patch wins)
  const backgroundedSubagentToolUseIds = useMemo(() => {
    const toolUseIds = new Set<string>();
    for (const activity of stripSourceActivities) {
      if (activity.kind !== "task.updated") {
        continue;
      }
      const payload =
        activity.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : null;
      const toolUseId = typeof payload?.toolUseId === "string" ? payload.toolUseId : null;
      if (!toolUseId || typeof payload?.isBackgrounded !== "boolean") {
        continue;
      }
      if (payload.isBackgrounded) {
        toolUseIds.add(toolUseId);
      } else {
        toolUseIds.delete(toolUseId);
      }
    }
    return toolUseIds;
  }, [stripSourceActivities]);
  const composerSubagentStripItems = useMemo(
    () =>
      deriveComposerSubagentStripItems({
        workEntries: stripWorkLogEntries,
        liveTurnId: stripLiveTurnId,
        backgroundedProviderThreadIds: backgroundedSubagentToolUseIds,
        viewedThreadId: stripParentThread ? (activeThread?.id ?? null) : null,
        parentRow: stripParentThread
          ? { threadId: stripParentThread.id, label: stripParentThread.title ?? null }
          : null,
      }),
    [
      activeThread?.id,
      backgroundedSubagentToolUseIds,
      stripLiveTurnId,
      stripParentThread,
      stripWorkLogEntries,
    ],
  );
  // links workflow agent rows to their subagent child threads when the Task tool_use_id produced one
  const workflowSubagentThreadsByToolUseId = useMemo(() => {
    const refs = new Map<string, WorkflowSubagentThreadRef>();
    for (const entry of enrichedWorkLogEntries) {
      for (const subagent of entry.subagents ?? []) {
        if (!subagent.providerThreadId) {
          continue;
        }
        refs.set(subagent.providerThreadId, {
          threadId: subagent.resolvedThreadId ?? subagent.threadId,
          model: subagent.model,
          effort: subagent.effort,
        });
      }
    }
    return refs;
  }, [enrichedWorkLogEntries]);
  // persisted per-thread workflow flags (pausedByUser, dismissed) survive reloads via workflowRunUiStore instead of component state
  const workflowRunUiThreadState = useWorkflowRunUiThreadState(activeThreadId);
  const pausedWorkflowTaskIds = useMemo(
    () => new Set(workflowRunUiThreadState.pausedByUser),
    [workflowRunUiThreadState.pausedByUser],
  );
  const dismissedWorkflowTaskIds = useMemo(
    () => new Set(workflowRunUiThreadState.dismissed),
    [workflowRunUiThreadState.dismissed],
  );
  const workflowRunState = useMemo(
    () =>
      deriveWorkflowRunState({
        activities: threadActivities,
        subagentThreadsByToolUseId: workflowSubagentThreadsByToolUseId,
        pausedByUserTaskIds: pausedWorkflowTaskIds,
        dismissedTaskIds: dismissedWorkflowTaskIds,
      }),
    [
      threadActivities,
      workflowSubagentThreadsByToolUseId,
      pausedWorkflowTaskIds,
      dismissedWorkflowTaskIds,
    ],
  );
  return {
    workLogEntries,
    composerSubagentStripItems,
    stripSourceThreadId,
    workflowRunState,
  };
}
