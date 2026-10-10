// FILE: useSubagentStripSource.ts
// Purpose: Resolves the work-log source behind every subagent surface (composer strip,
//          Environment panel summary, right-dock Subagents pane): the thread's own
//          activities, or, while a subagent thread is open, its parent's, so siblings and a
//          row back to the parent stay visible. Enriches the routed subagent entries with
//          child-thread status and folds the provider's background confirmations.
// Layer: Chat hooks
// Exports: useSubagentStripSource, useSubagentRoster, useThreadSubagentRoster

import type { OrchestrationThreadActivity, ThreadId, TurnId } from "@synara/contracts";
import { useEffect, useMemo } from "react";

import { deriveWorkLogEntries, isLatestTurnSettled, type WorkLogEntry } from "../../session-logic";
import { useStore } from "../../store";
import { createThreadSelector } from "../../storeSelectors";
import { retainThreadDetailSubscription } from "../../threadDetailSubscriptionRetention";
import type { Thread } from "../../types";
import { enrichSubagentWorkEntries, resolveComposerStripWorkLogEntries } from "../ChatView.logic";
import { createRelevantWorkLogThreadsSelector } from "../ChatView.selectors";
import {
  deriveEnvironmentSubagentRoster,
  EMPTY_ENVIRONMENT_SUBAGENT_ROSTER,
  type EnvironmentSubagentRoster,
} from "./environment/EnvironmentSubagentsSection.logic";

const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];

export interface SubagentParentRow {
  readonly threadId: ThreadId;
  readonly label: string | null;
}

export interface SubagentStripSource {
  stripParentThread: Thread | undefined;
  stripSourceThreadId: ThreadId | null;
  stripSourceActivities: ReadonlyArray<OrchestrationThreadActivity>;
  stripLiveTurnId: TurnId | null;
  stripWorkLogEntries: WorkLogEntry[];
  hasStripWorkLogSubagents: boolean;
  backgroundedSubagentToolUseIds: ReadonlySet<string>;
  subagentParentRow: SubagentParentRow | null;
  // The open thread when it is one of the listed subagents (marks its row as viewed).
  viewedSubagentThreadId: ThreadId | null;
}

// Task tool_use_ids the provider confirmed as backgrounded via task_updated patches
// (last patch wins, so re-foregrounded tasks drop back out).
function collectBackgroundedSubagentToolUseIds(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Set<string> {
  const toolUseIds = new Set<string>();
  for (const activity of activities) {
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
}

export function useSubagentStripSource(input: {
  activeThread: Thread | undefined;
  latestTurnSettled: boolean;
  // ChatView already derives the active thread's raw work log for the transcript; a
  // top-level thread reuses it so every live activity does not scan the history twice.
  activeRawWorkLogEntries?: WorkLogEntry[] | undefined;
}): SubagentStripSource {
  const { activeThread, latestTurnSettled, activeRawWorkLogEntries } = input;
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
  const sourceThread = stripParentThread ?? activeThread;
  const stripSourceThreadId = sourceThread?.id ?? null;
  const stripSourceActivities = sourceThread?.activities ?? EMPTY_ACTIVITIES;
  const sourceLatestTurn = sourceThread?.latestTurn ?? null;
  const stripSourceLatestTurnId = sourceLatestTurn?.turnId ?? null;
  const stripSourceLatestTurnState = sourceLatestTurn?.state ?? null;
  const stripSourceLatestTurnStartedAt = sourceLatestTurn?.startedAt ?? null;
  const stripSourceLatestTurnCompletedAt = sourceLatestTurn?.completedAt ?? null;
  const sourceMessages = sourceThread?.messages;
  const stripVisibleTurnIds = useMemo(() => {
    const turnIds = new Set<TurnId>();
    for (const message of sourceMessages ?? []) {
      if (message.turnId) {
        turnIds.add(message.turnId);
      }
    }
    if (stripSourceLatestTurnId) {
      turnIds.add(stripSourceLatestTurnId);
    }
    return turnIds;
  }, [sourceMessages, stripSourceLatestTurnId]);
  const stripLiveTurnId = stripParentThread
    ? isLatestTurnSettled(stripParentThread.latestTurn, stripParentThread.session ?? null)
      ? null
      : stripSourceLatestTurnId
    : latestTurnSettled
      ? null
      : stripSourceLatestTurnId;
  // The strip needs the routed subagent entries the transcript drops. Subagent views
  // (and callers without a transcript) derive from the source thread themselves.
  const reusesActiveEntries =
    stripParentThread === undefined && activeRawWorkLogEntries !== undefined;
  const stripRawWorkLogEntries = useMemo(
    () =>
      resolveComposerStripWorkLogEntries({
        hasDistinctParentSource: !reusesActiveEntries,
        activeWorkLogEntries: activeRawWorkLogEntries ?? [],
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
      activeRawWorkLogEntries,
      reusesActiveEntries,
      stripLiveTurnId,
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
  const backgroundedSubagentToolUseIds = useMemo(
    () => collectBackgroundedSubagentToolUseIds(stripSourceActivities),
    [stripSourceActivities],
  );
  // Row back to the parent while a subagent thread is open. Keyed on id/title so parent
  // streaming does not churn the row's identity.
  const loadedStripParentThreadId = stripParentThread?.id ?? null;
  const stripParentThreadTitle = stripParentThread?.title ?? null;
  const subagentParentRow = useMemo(
    () =>
      loadedStripParentThreadId
        ? { threadId: loadedStripParentThreadId, label: stripParentThreadTitle }
        : null,
    [loadedStripParentThreadId, stripParentThreadTitle],
  );

  return {
    stripParentThread,
    stripSourceThreadId,
    stripSourceActivities,
    stripLiveTurnId,
    stripWorkLogEntries,
    hasStripWorkLogSubagents,
    backgroundedSubagentToolUseIds,
    subagentParentRow,
    viewedSubagentThreadId: stripParentThread ? (activeThread?.id ?? null) : null,
  };
}

// The full roster (live and settled) over the strip's source, without the strip's
// live-turn scoping, so settled subagents stay listed after the strip retires.
export function useSubagentRoster(source: SubagentStripSource): EnvironmentSubagentRoster {
  const {
    backgroundedSubagentToolUseIds,
    hasStripWorkLogSubagents,
    stripSourceActivities,
    stripWorkLogEntries,
    viewedSubagentThreadId,
  } = source;
  return useMemo(
    () =>
      hasStripWorkLogSubagents
        ? deriveEnvironmentSubagentRoster({
            workEntries: stripWorkLogEntries,
            activities: stripSourceActivities,
            backgroundedProviderThreadIds: backgroundedSubagentToolUseIds,
            viewedThreadId: viewedSubagentThreadId,
          })
        : EMPTY_ENVIRONMENT_SUBAGENT_ROSTER,
    [
      backgroundedSubagentToolUseIds,
      hasStripWorkLogSubagents,
      stripSourceActivities,
      stripWorkLogEntries,
      viewedSubagentThreadId,
    ],
  );
}

// Standalone roster for surfaces outside ChatView (the right-dock Subagents pane).
export function useThreadSubagentRoster(threadId: ThreadId): {
  roster: EnvironmentSubagentRoster;
  source: SubagentStripSource;
} {
  const thread = useStore(useMemo(() => createThreadSelector(threadId), [threadId]));
  const source = useSubagentStripSource({
    activeThread: thread,
    latestTurnSettled: isLatestTurnSettled(thread?.latestTurn ?? null, thread?.session ?? null),
  });
  const roster = useSubagentRoster(source);
  return { roster, source };
}
