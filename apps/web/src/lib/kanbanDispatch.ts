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
  | { kind: "dispatched" }
  /** The board cannot dispatch this card faithfully — open the chat instead. */
  | { kind: "open-thread"; reason: KanbanDraftOpenThreadReason }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

export { resolveDraftThreadDispatchTarget as resolveKanbanDraftDispatchTarget } from "./draftThreadDispatch";
export type { DraftThreadDispatchTarget as KanbanDraftDispatchTarget } from "./draftThreadDispatch";

export async function dispatchKanbanDraftCard(input: {
  card: KanbanCard;
  defaultProvider: ProviderKind;
  assistantDeliveryMode: AssistantDeliveryMode;
  providerOptions?: ProviderStartOptions | undefined;
  providerInstances?: ReadonlyArray<DraftDispatchProviderInstance> | undefined;
}): Promise<KanbanDraftDispatchResult> {
  const { card } = input;
  if (resolveDraftDropAction(card) !== "dispatch") {
    return {
      kind: "open-thread",
      reason: resolveKanbanDraftOpenThreadReason(card) ?? "not-draft",
    };
  }
  return dispatchKanbanDraftThread({
    threadId: card.threadId,
    projectId: card.projectId,
    thread: card.thread,
    defaultProvider: input.defaultProvider,
    assistantDeliveryMode: input.assistantDeliveryMode,
    providerOptions: input.providerOptions,
    providerInstances: input.providerInstances,
  });
}

interface KanbanDraftDispatchInput {
  threadId: ThreadId;
  projectId: ProjectId;
  /** Backing summary; null for local-only draft threads not yet promoted. */
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
  const { threadId, projectId } = input;
  const kanbanUi = useKanbanUiStore.getState();
  return dispatchDraftThread({
    ...input,
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
