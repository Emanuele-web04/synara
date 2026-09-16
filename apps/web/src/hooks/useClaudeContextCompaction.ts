import type { MessageId, ThreadId } from "@synara/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { toastManager } from "../components/ui/toast";
import { newCommandId, newMessageId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import {
  deriveActiveBackgroundTasksState,
  derivePendingApprovals,
  derivePendingUserInputs,
} from "../session-logic";

/** Request Claude's native command through the normal durable user-turn path. */
export function useClaudeContextCompaction({
  threadId,
  disabledReason,
  onBegin,
  onAccepted,
  onFailure,
}: {
  threadId: ThreadId;
  disabledReason: string | null;
  onBegin: (input: { expectedUserMessageId: MessageId }) => void;
  onAccepted: (threadId: ThreadId) => void;
  onFailure: () => void;
}) {
  const inFlightThreadIdsRef = useRef(new Set<ThreadId>());
  const activeThreadIdRef = useRef(threadId);
  const [submittingThreadIds, setSubmittingThreadIds] = useState<ReadonlySet<ThreadId>>(
    () => new Set(),
  );
  useEffect(() => {
    activeThreadIdRef.current = threadId;
  }, [threadId]);

  const compact = useCallback(async (): Promise<boolean> => {
    if (inFlightThreadIdsRef.current.has(threadId) || disabledReason !== null) return false;
    const api = readNativeApi();
    const thread = getThreadFromState(useStore.getState(), threadId);
    if (
      !api ||
      !thread ||
      thread.modelSelection.provider !== "claudeAgent" ||
      thread.session?.provider !== "claudeAgent" ||
      thread.session.status === "running" ||
      thread.session.status === "connecting" ||
      thread.session.activeTurnId != null ||
      thread.claudeCacheReview != null ||
      thread.archivedAt != null ||
      thread.sidechatExpiredAt != null
    )
      return false;
    const latestTurnId = thread.latestTurn?.turnId;
    if (
      thread.hasPendingApprovals === true ||
      thread.hasPendingUserInput === true ||
      derivePendingApprovals(thread.activities, thread.pendingInteractions, {
        authoritativeHasPending: thread.hasPendingApprovals,
        latestTurnId,
      }).length > 0 ||
      derivePendingUserInputs(thread.activities, thread.pendingInteractions, {
        authoritativeHasPending: thread.hasPendingUserInput,
        latestTurnId,
      }).length > 0 ||
      deriveActiveBackgroundTasksState(thread.activities, latestTurnId) !== null
    )
      return false;

    const messageId = newMessageId();
    inFlightThreadIdsRef.current.add(threadId);
    setSubmittingThreadIds((current) => new Set([...current, threadId]));
    onBegin({ expectedUserMessageId: messageId });
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId,
        message: { messageId, role: "user", text: "/compact", attachments: [] },
        dispatchMode: "queue",
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: new Date().toISOString(),
      });
      if (activeThreadIdRef.current === threadId) onAccepted(threadId);
      return true;
    } catch (error) {
      // A lost RPC response must not turn an accepted native command into a retry.
      const current = getThreadFromState(useStore.getState(), threadId);
      if (
        current?.claudeCacheReview?.messageId === messageId ||
        current?.messages.some((message) => message.id === messageId)
      ) {
        if (activeThreadIdRef.current === threadId) onAccepted(threadId);
        return true;
      }
      if (activeThreadIdRef.current === threadId) onFailure();
      toastManager.add({
        type: "error",
        title: "Could not request compaction",
        description: error instanceof Error ? error.message : "Try again when Claude is ready.",
      });
      return false;
    } finally {
      inFlightThreadIdsRef.current.delete(threadId);
      setSubmittingThreadIds((current) => new Set([...current].filter((id) => id !== threadId)));
    }
  }, [disabledReason, onAccepted, onBegin, onFailure, threadId]);

  return { compact, isSubmitting: submittingThreadIds.has(threadId) };
}
