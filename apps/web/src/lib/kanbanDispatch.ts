// FILE: kanbanDispatch.ts
// Purpose: Sends a kanban Draft card to In Progress — the shared draft-thread dispatch
//          plus the board's optimistic card move and chat-project retitle.
// Layer: Web orchestration helper
// Exports: dispatchKanbanDraftCard, dispatchKanbanDraftThread, KanbanDraftDispatchResult

import type {
  AssistantDeliveryMode,
  ProjectId,
  ProviderKind,
  ProviderStartOptions,
  ThreadId,
} from "@synara/contracts";
import {
  resolveKanbanDraftOpenThreadReason,
  resolveDraftDropAction,
  type KanbanCard,
  type KanbanDraftOpenThreadReason,
} from "../components/kanban/kanban.logic";
import { useKanbanUiStore } from "../kanbanUiStore";
import type { SidebarThreadSummary } from "../types";
import { dispatchDraftThread, type DraftDispatchProviderInstance } from "./draftThreadDispatch";

export type KanbanDraftDispatchResult =
  /** The drafted prompt is on its way; runtime events move the card to In Progress. */
  | { kind: "dispatched"; warning?: string | undefined; deferred?: true | undefined }
  /** The board cannot dispatch this card faithfully — open the chat instead. */
  | { kind: "open-thread"; reason: KanbanDraftOpenThreadReason }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

export { resolveDraftThreadDispatchTarget as resolveKanbanDraftDispatchTarget } from "./draftThreadDispatch";
export type { DraftThreadDispatchTarget as KanbanDraftDispatchTarget } from "./draftThreadDispatch";

export function kanbanDispatchFailureToast(
  result: Exclude<KanbanDraftDispatchResult, { kind: "dispatched" }>,
  errorTitle: string,
): { type: "info" | "error"; title: string; description: string } {
  if (result.kind === "open-thread") {
    return {
      type: "info",
      title: "Finish this draft in the chat",
      description:
        result.reason === "empty"
          ? "Nothing to send yet. Write the prompt in the composer."
          : result.reason === "worktree-pending"
            ? "Open the chat to create the worktree with the normal send flow."
            : "Open the chat to continue this task.",
    };
  }
  if (result.kind === "unavailable") {
    return {
      type: "error",
      title: "Not connected",
      description: "Reconnect to the server before sending drafts.",
    };
  }
  return { type: "error", title: errorTitle, description: result.message };
}

export async function dispatchKanbanDraftCard(input: {
  card: KanbanCard;
  defaultProvider: ProviderKind;
  assistantDeliveryMode: AssistantDeliveryMode;
  providerOptions?: ProviderStartOptions | undefined;
  providerInstances?: ReadonlyArray<DraftDispatchProviderInstance> | undefined;
}): Promise<KanbanDraftDispatchResult> {
  return dispatchKanbanDraftCardInternal(input, false);
}

export function dispatchKanbanDraftCardAsGoal(
  input: Parameters<typeof dispatchKanbanDraftCard>[0],
): Promise<KanbanDraftDispatchResult> {
  return dispatchKanbanDraftCardInternal(input, true);
}

async function dispatchKanbanDraftCardInternal(
  input: Parameters<typeof dispatchKanbanDraftCard>[0],
  sendAsGoal: boolean,
): Promise<KanbanDraftDispatchResult> {
  const { card } = input;
  if (resolveDraftDropAction(card) !== "dispatch") {
    return {
      kind: "open-thread",
      reason: resolveKanbanDraftOpenThreadReason(card) ?? "not-draft",
    };
  }
  return dispatchKanbanDraftThreadInternal(
    {
      threadId: card.threadId,
      projectId: card.projectId,
      thread: card.thread,
      defaultProvider: input.defaultProvider,
      assistantDeliveryMode: input.assistantDeliveryMode,
      providerOptions: input.providerOptions,
      providerInstances: input.providerInstances,
    },
    sendAsGoal,
  );
}

interface KanbanDraftDispatchInput {
  threadId: ThreadId;
  projectId: ProjectId;
  thread: SidebarThreadSummary | null;
  defaultProvider: ProviderKind;
  assistantDeliveryMode: AssistantDeliveryMode;
  providerOptions?: ProviderStartOptions | undefined;
  providerInstances?: ReadonlyArray<DraftDispatchProviderInstance> | undefined;
}

/**
 * Promote (when needed) and dispatch a draft thread's composer prompt as a queued
 * turn. Shared by the board's drag-to-In-Progress drop and the new-task dialog's
 * "send now" path, so both routes stay byte-for-byte consistent. Concurrent calls
 * for the same thread coalesce onto the first dispatch.
 */
export function dispatchKanbanDraftThread(
  input: KanbanDraftDispatchInput,
): Promise<KanbanDraftDispatchResult> {
  return dispatchKanbanDraftThreadInternal(input, false);
}

export function dispatchKanbanDraftThreadAsGoal(
  input: KanbanDraftDispatchInput,
): Promise<KanbanDraftDispatchResult> {
  return dispatchKanbanDraftThreadInternal(input, true);
}

function dispatchKanbanDraftThreadInternal(
  input: KanbanDraftDispatchInput,
  sendAsGoal: boolean,
): Promise<KanbanDraftDispatchResult> {
  const { threadId, projectId } = input;
  const kanbanUi = useKanbanUiStore.getState();
  return dispatchDraftThread({
    ...input,
    sendAsGoal,
    promptAsFile: true,
    hooks: {
      // Optimistic move: show the card In Progress before any round-trip. Provider
      // session init can take seconds; runtime events confirm the move (reconciliation
      // clears the entry) or an abandoned dispatch reverts it.
      onDispatchStart: ({ title, provider, providerInstanceId, baselineTurnId, startedAtMs }) =>
        kanbanUi.markOptimisticDispatch(threadId, {
          projectId,
          title,
          provider,
          providerInstanceId,
          baselineTurnId,
          droppedAtMs: startedAtMs,
        }),
      onDispatchAbandoned: () => kanbanUi.clearOptimisticDispatch(threadId),
      renameChatProject: true,
    },
  });
}
