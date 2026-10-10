// FILE: useTaskAgent.ts
// Purpose: The live agent state the task inspector shows for a delegated to-do (what the
//          chat's thread holds: pending requests, recent activity, the latest reply) and the
//          two things the panel can do to it (answer an approval, stop the turn).
// Layer: Tasks UI hooks
// Exports: useTaskAgentThread, useTaskAgentActions

import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  RuntimeMode,
  ThreadId,
} from "@synara/contracts";
import { useEffect, useMemo, useState } from "react";

import { isReasoningUpdateWorkEntry } from "~/components/chat/agentActivity.logic";
import { respondToThreadApproval } from "~/components/chat/respondToThreadApproval";
import { toastManager } from "~/components/ui/toast";
import { interruptThreadTurn } from "~/lib/threadTurnInterrupt";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  canSessionAnswerPendingRequests,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveWorkLogEntries,
  type PendingApproval,
} from "../../session-logic";
import { useStore } from "../../store";
import { createThreadSelector } from "../../storeSelectors";
import { retainThreadDetailSubscription } from "../../threadDetailSubscriptionRetention";
import type { TaskStatusKind } from "./tasks.logic";

const RECENT_ACTIVITY_LIMIT = 4;

export function useTaskAgentThread(threadId: ThreadId, statusKind: TaskStatusKind) {
  // Activities and pending requests live on the thread detail, which is only streamed
  // for subscribed threads — hold one for as long as the inspector shows this chat.
  useEffect(() => retainThreadDetailSubscription(threadId), [threadId]);
  const thread = useStore(useMemo(() => createThreadSelector(threadId), [threadId]));

  const canAnswer = canSessionAnswerPendingRequests(thread?.session ?? null);
  const latestTurnId = thread?.latestTurn?.turnId;
  const pendingApprovals = useMemo(
    () =>
      thread && canAnswer
        ? derivePendingApprovals(thread.activities, thread.pendingInteractions, {
            authoritativeHasPending: thread.hasPendingApprovals,
            latestTurnId,
          })
        : [],
    [canAnswer, latestTurnId, thread],
  );
  const hasPendingUserInput = useMemo(
    () =>
      thread && canAnswer
        ? derivePendingUserInputs(thread.activities, thread.pendingInteractions, {
            authoritativeHasPending: thread.hasPendingUserInput,
            latestTurnId,
          }).length > 0
        : false,
    [canAnswer, latestTurnId, thread],
  );
  const recentActivity = useMemo(() => {
    // Starting on a reused chat: the latest turn there is still earlier, unrelated work.
    if (!thread || !latestTurnId || statusKind === "starting") return [];
    return (
      deriveWorkLogEntries(thread.activities, latestTurnId, {
        visibleTurnIds: new Set([latestTurnId]),
        activeTurnId: statusKind === "running" ? latestTurnId : null,
        activeTurnStartedAt: thread.latestTurn?.startedAt ?? null,
        latestTurnState: thread.latestTurn?.state ?? null,
        latestTurnCompletedAt: thread.latestTurn?.completedAt ?? null,
      })
        // Reasoning is the chat's to show; approval rows restate the inline approval card.
        .filter(
          (entry) =>
            entry.tone !== "thinking" &&
            !isReasoningUpdateWorkEntry(entry) &&
            entry.activityKind !== "approval.requested" &&
            entry.activityKind !== "approval.resolved",
        )
        .slice(-RECENT_ACTIVITY_LIMIT)
    );
  }, [latestTurnId, statusKind, thread]);
  const latestReply = useMemo(() => {
    if (!thread || statusKind !== "review") return null;
    // Only the delegated (latest) turn's answer; an older one in a reused chat isn't it.
    const reply = thread.messages.findLast(
      (message) =>
        message.role === "assistant" &&
        message.turnId === latestTurnId &&
        message.text.trim().length > 0,
    );
    return reply?.text.trim() ?? null;
  }, [latestTurnId, statusKind, thread]);

  return { thread, pendingApprovals, hasPendingUserInput, recentActivity, latestReply };
}

/** `threadRuntimeMode` is the chat's own mode, used when the composer draft has none. */
export function useTaskAgentActions(
  threadId: ThreadId,
  threadRuntimeMode: RuntimeMode | undefined,
) {
  const [respondingKey, setRespondingKey] = useState<string | null>(null);
  const [isStopping, setIsStopping] = useState(false);

  const respondToApproval = async (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
    lifecycleGeneration?: string,
    requestKind?: PendingApproval["requestKind"],
  ) => {
    setRespondingKey(requestId);
    try {
      await respondToThreadApproval({
        threadId,
        requestId,
        decision,
        lifecycleGeneration,
        requestKind,
        runtimeMode:
          useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode ??
          threadRuntimeMode ??
          "approval-required",
      });
    } catch (error) {
      // The chat shows the error too, but this panel is where the user answered.
      toastManager.add({
        type: "error",
        title: "Couldn't send your answer",
        description: error instanceof Error ? error.message : "Try again from the chat.",
      });
    } finally {
      setRespondingKey(null);
    }
  };
  const stop = async () => {
    setIsStopping(true);
    try {
      await interruptThreadTurn(threadId);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't stop the agent",
        description: error instanceof Error ? error.message : "Unexpected error.",
      });
    } finally {
      setIsStopping(false);
    }
  };

  return { respondingKey, isStopping, respondToApproval, stop };
}
