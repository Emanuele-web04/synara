import { OrchestrationThreadActivity, type TurnId } from "@synara/contracts";
import { useMemo } from "react";
import { deriveWorkLogEntries, deriveSubagentTaskEnds } from "../../session-logic";
import { useStore } from "../../store";
import type { Thread } from "../../types";
import { useWorkflowRunUiThreadState } from "../../workflowRunUiStore";
import { enrichSubagentWorkEntries } from "../ChatView.logic";
import { createRelevantWorkLogThreadsSelector } from "../ChatView.selectors";
import { deriveComposerSubagentStripItems } from "./ComposerSubagentStrip.logic";
import { findLatestSubagentThreadRun, foldSubagentRunWorkEntries } from "./SubagentRunCard.logic";
import { useSubagentRoster, useSubagentStripSource } from "./useSubagentStripSource";
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
  // Subagents are presented by the composer strip (and their own threads); the
  // transcript drops the routed fan-out rows entirely. The enriched list above is
  // still what feeds the strip-adjacent derivations that need receiver metadata.
  const workLogEntries = useMemo(
    () => foldSubagentRunWorkEntries(enrichedWorkLogEntries),
    [enrichedWorkLogEntries],
  );
  const subagentSource = useSubagentStripSource({
    activeThread,
    latestTurnSettled,
    activeRawWorkLogEntries: rawWorkLogEntries,
  });
  const {
    backgroundedSubagentToolUseIds,
    stripLiveTurnId,
    stripSourceThreadId,
    stripWorkLogEntries,
    subagentParentRow,
    viewedSubagentThreadId,
  } = subagentSource;
  const composerSubagentStripItems = useMemo(
    () =>
      deriveComposerSubagentStripItems({
        workEntries: stripWorkLogEntries,
        liveTurnId: stripLiveTurnId,
        backgroundedProviderThreadIds: backgroundedSubagentToolUseIds,
        viewedThreadId: viewedSubagentThreadId,
        parentRow: subagentParentRow,
      }),
    [
      backgroundedSubagentToolUseIds,
      stripLiveTurnId,
      stripWorkLogEntries,
      subagentParentRow,
      viewedSubagentThreadId,
    ],
  );
  const subagentRoster = useSubagentRoster(subagentSource);
  const subagentTaskEnds = useMemo(() => deriveSubagentTaskEnds(subagentSource.stripSourceActivities), [subagentSource.stripSourceActivities]);
  const subagentThreadRunRow = useMemo(() =>
    activeThread?.parentThreadId && activeThreadId ? findLatestSubagentThreadRun({
      entries: foldSubagentRunWorkEntries(stripWorkLogEntries), threads: subagentSource.stripRelevantWorkLogThreads,
      parentThreadId: stripSourceThreadId, liveTurnId: stripLiveTurnId, childThreadId: activeThreadId,
      taskEndByToolUseId: subagentTaskEnds, backgroundedProviderThreadIds: backgroundedSubagentToolUseIds,
    }) : null,
    [activeThread?.parentThreadId, activeThreadId, stripWorkLogEntries, subagentSource.stripRelevantWorkLogThreads, stripSourceThreadId, stripLiveTurnId, subagentTaskEnds, backgroundedSubagentToolUseIds]);
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
    subagentRunThreads: relevantWorkLogThreads,
    backgroundedSubagentToolUseIds,
    subagentTaskEnds,
    subagentThreadRunRow,
    composerSubagentStripItems,
    subagentRoster,
    stripSourceThreadId,
    workflowRunState,
  };
}
