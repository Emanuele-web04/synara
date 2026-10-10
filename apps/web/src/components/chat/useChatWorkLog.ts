import { OrchestrationThreadActivity, ThreadId, type TurnId } from "@synara/contracts";
import { useEffect, useMemo } from "react";
import {
  deriveSubagentTaskEnds,
  deriveWorkLogEntries,
  isLatestTurnSettled,
} from "../../session-logic";
import { useStore } from "../../store";
import { createThreadSelector } from "../../storeSelectors";
import { retainThreadDetailSubscription } from "../../threadDetailSubscriptionRetention";
import type { Thread } from "../../types";
import { useWorkflowRunUiThreadState } from "../../workflowRunUiStore";
import { enrichSubagentWorkEntries, resolveComposerStripWorkLogEntries } from "../ChatView.logic";
import { createRelevantWorkLogThreadsSelector } from "../ChatView.selectors";
import { deriveComposerSubagentStripItems } from "./ComposerSubagentStrip.logic";
import { findLatestSubagentThreadRun, foldSubagentRunWorkEntries } from "./SubagentRunCard.logic";
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
  const subagentRunRootThreadId = activeThread?.parentThreadId ?? activeThreadId;
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const activeLatestTurnId = activeLatestTurn?.turnId ?? null;
  const activeLatestTurnStartedAt = activeLatestTurn?.startedAt ?? null;
  const activeLatestTurnState = activeLatestTurn?.state ?? null;
  const activeLatestTurnCompletedAt = activeLatestTurn?.completedAt ?? null;
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  // User messages intentionally have no turn id; assistant messages are the stable
  // bridge for deciding which historical work can fold into visible replies.
  // Memoized on purpose: an inline Set would change identity every render and cascade
  // through the memoized work-log/timeline chain into the virtualized list, which resets
  // in a loop on unstable data.
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
          parentThreadId: subagentRunRootThreadId,
          enabled: hasWorkLogSubagents,
        }),
      [subagentRunRootThreadId, hasWorkLogSubagents, rawWorkLogEntries],
    ),
  );
  const enrichedWorkLogEntries = useMemo(
    () =>
      hasWorkLogSubagents
        ? enrichSubagentWorkEntries(
            rawWorkLogEntries,
            relevantWorkLogThreads,
            subagentRunRootThreadId,
          )
        : rawWorkLogEntries,
    [subagentRunRootThreadId, hasWorkLogSubagents, rawWorkLogEntries, relevantWorkLogThreads],
  );
  // A turn's subagents fold into one card entry where they were launched (the
  // routed fan-out rows and their progress reports never render as tool rows).
  const workLogEntries = useMemo(
    () => foldSubagentRunWorkEntries(enrichedWorkLogEntries),
    [enrichedWorkLogEntries],
  );
  // The strip's liveness (running/settled) reads the child thread's own session and
  // tail activities, so retain a detail subscription while a subagent runs; settled
  // subagents stay on whatever the store already holds.
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
  // Native-CLI parity: while a subagent thread is open, the strip derives from the
  // PARENT thread's activities so all sibling subagents (plus a way back to the
  // main thread) stay visible, with the open subagent marked as viewed.
  const stripParentThreadId = activeThread?.parentThreadId ?? null;
  const stripParentThread = useStore(
    useMemo(() => createThreadSelector(stripParentThreadId), [stripParentThreadId]),
  );
  // Deep links can land on a subagent thread before the parent has a detail
  // subscription; retain one so the parent's activities hydrate for the strip.
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
  // Composer-strip source: the strip needs the routed subagent entries the
  // transcript drops. A top-level thread has already derived that exact source
  // above; reuse it so every live activity does not scan and normalize the full
  // history twice. Subagent views still derive from their distinct parent source.
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

  // Task tool_use_ids the provider confirmed as backgrounded via task_updated
  // patches (last patch wins, so re-foregrounded tasks drop back out).
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
  // When each subagent task ended (parent-side task completions): the card's
  // authority for background subagents, whose own threads end at launch.
  const subagentTaskEnds = useMemo(
    () => deriveSubagentTaskEnds(stripSourceActivities),
    [stripSourceActivities],
  );
  // Codex children do not have a provider session or a closing turn of their
  // own. Their launcher reports the same authoritative outcome the card uses.
  const subagentThreadRunRow = useMemo(
    () =>
      activeThread?.parentThreadId
        ? findLatestSubagentThreadRun({
            entries: foldSubagentRunWorkEntries(stripWorkLogEntries),
            threads: stripRelevantWorkLogThreads,
            parentThreadId: stripSourceThreadId,
            liveTurnId: stripLiveTurnId,
            childThreadId: activeThread.id,
            taskEndByToolUseId: subagentTaskEnds,
            backgroundedProviderThreadIds: backgroundedSubagentToolUseIds,
          })
        : null,
    [
      activeThread?.id,
      activeThread?.parentThreadId,
      stripWorkLogEntries,
      stripRelevantWorkLogThreads,
      stripSourceThreadId,
      stripLiveTurnId,
      subagentTaskEnds,
      backgroundedSubagentToolUseIds,
    ],
  );
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
  // Links workflow agent rows to their subagent child threads (and models) when the
  // Task tool_use_id produced one; agents spawned without a tool call stay unlinked.
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
  // Persisted (per-thread) workflow run flags: pausedByUser tells the settled
  // card apart from a plain stop; dismissed retires a settled card the run's
  // activities would otherwise keep visible. Survive reloads via
  // workflowRunUiStore instead of living in component state.
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
    // The parent's child threads (and theirs), which the transcript card reads
    // for live state, durations, and result previews.
    subagentRunThreads: relevantWorkLogThreads,
    backgroundedSubagentToolUseIds,
    subagentTaskEnds,
    subagentThreadRunRow,
    composerSubagentStripItems,
    stripSourceThreadId,
    workflowRunState,
  };
}
