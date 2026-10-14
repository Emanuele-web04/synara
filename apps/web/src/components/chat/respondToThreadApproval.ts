// FILE: respondToThreadApproval.ts
// Purpose: The one way a surface answers a thread's pending approval — the chat's
//          approval card and the Tasks inspector both send decisions through it, so the
//          durable "always allow" runtime mode and the already-answered race stay handled
//          identically.
// Layer: Chat command helper
// Exports: respondToThreadApproval

import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderRequestKind,
  RuntimeMode,
  ThreadId,
} from "@synara/contracts";
import {
  APPROVAL_ALREADY_ANSWERED_INVARIANT_MARKER,
  collectErrorMessages,
  describeErrorMessage,
} from "@synara/shared/errorMessages";

import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useStore } from "../../store";
import {
  buildThreadSubscribeInput,
  clearThreadDetailResumeCursor,
} from "../../threadDetailResumeCursors";
import { resolveRuntimeModeAfterApprovalDecision } from "../ChatView.logic";

/**
 * Sends the decision. Resolves when it was recorded — including when another surface
 * answered first — and rejects (after surfacing the error on the thread) otherwise.
 */
export async function respondToThreadApproval(input: {
  threadId: ThreadId;
  requestId: ApprovalRequestId;
  decision: ProviderApprovalDecision;
  lifecycleGeneration?: string | undefined;
  requestKind?: ProviderRequestKind | undefined;
  /** The thread's current runtime mode, to persist a supervised "always allow". */
  runtimeMode: RuntimeMode;
}): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  const { threadId, requestId, decision, lifecycleGeneration } = input;
  const setThreadError = useStore.getState().setError;
  // Persist supervised "always allow" client-side so the next turn (after an
  // idle-stop or runtime restart) uses full access. Auto remains the durable
  // thread policy; its server-side override applies only to the live session.
  const durableRuntimeMode = resolveRuntimeModeAfterApprovalDecision(
    input.runtimeMode,
    decision,
    input.requestKind,
  );
  if (durableRuntimeMode) {
    useComposerDraftStore.getState().setRuntimeMode(threadId, durableRuntimeMode);
  }
  await api.orchestration
    .dispatchCommand({
      type: "thread.approval.respond",
      commandId: newCommandId(),
      threadId,
      requestId,
      decision,
      ...(lifecycleGeneration !== undefined ? { lifecycleGeneration } : {}),
      createdAt: new Date().toISOString(),
    })
    .catch(async (err: unknown) => {
      if (
        collectErrorMessages(err).some((message) =>
          message.includes(APPROVAL_ALREADY_ANSWERED_INVARIANT_MARKER),
        )
      ) {
        // The authoritative response won the race. Force a full detail
        // snapshot so a stale local card cannot immediately submit again.
        clearThreadDetailResumeCursor(threadId);
        await api.orchestration.subscribeThread(buildThreadSubscribeInput(threadId)).catch(() => {
          setThreadError(
            threadId,
            "Approval was already recorded, but the conversation could not be refreshed.",
          );
        });
        return;
      }
      setThreadError(threadId, describeErrorMessage(err, "Failed to submit approval decision."));
      throw err;
    });
}
