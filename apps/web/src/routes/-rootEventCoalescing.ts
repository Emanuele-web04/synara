// FILE: -rootEventCoalescing.ts
// Purpose: Pure helpers for coalescing/classifying streamed orchestration events and reconciling promoted drafts.
// Layer: Root route utility
// Exports: Domain-event coalescing/flush predicates, thread-detail event matching, and promoted-draft reconciliation.

import {
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
} from "@t3tools/contracts";

import { finalizePromotedDraftThreads, markPromotedDraftThreads } from "../composerDraftStore";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";

export function shellThreadHasStarted(
  thread: OrchestrationShellSnapshot["threads"][number],
): boolean {
  return thread.latestTurn !== null || thread.session !== null;
}

export function detailThreadHasStarted(thread: OrchestrationThread): boolean {
  return shellThreadHasStarted(thread) || thread.messages.length > 0;
}

export function reconcilePromotedDraftsFromShellThreads(
  threads: ReadonlyArray<OrchestrationShellSnapshot["threads"][number]>,
): void {
  markPromotedDraftThreads(new Set(threads.map((thread) => thread.id)));
  finalizePromotedDraftThreads(
    new Set(threads.filter((thread) => shellThreadHasStarted(thread)).map((thread) => thread.id)),
  );
}

export function reconcilePromotedDraftFromThreadDetail(thread: OrchestrationThread): void {
  markPromotedDraftThreads(new Set([thread.id]));
  if (detailThreadHasStarted(thread)) {
    finalizePromotedDraftThreads(new Set([thread.id]));
  }
}

export function coalesceOrchestrationUiEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  if (events.length < 2) {
    return [...events];
  }

  const coalesced: OrchestrationEvent[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (
      previous?.type === "thread.message-sent" &&
      event.type === "thread.message-sent" &&
      previous.payload.threadId === event.payload.threadId &&
      previous.payload.messageId === event.payload.messageId
    ) {
      coalesced[coalesced.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          attachments: event.payload.attachments ?? previous.payload.attachments,
          createdAt: previous.payload.createdAt,
          text:
            !event.payload.streaming && event.payload.text.length > 0
              ? event.payload.text
              : previous.payload.text + event.payload.text,
        },
      };
      continue;
    }

    coalesced.push(event);
  }

  return coalesced;
}

export function shouldFlushDomainEventImmediately(
  event: OrchestrationEvent,
  immediatelyFlushedStreamKeys: Set<string>,
): boolean {
  if (event.type === "thread.message-sent" && event.payload.role === "user") {
    clearReasoningFlushKeysForThread(immediatelyFlushedStreamKeys, event.payload.threadId);
    return false;
  }

  if (
    event.type === "thread.activity-appended" &&
    event.payload.activity.kind === "reasoning.delta"
  ) {
    const streamKey = [
      "reasoning",
      event.payload.threadId,
      event.payload.activity.turnId ?? "turnless",
    ].join(":");
    if (immediatelyFlushedStreamKeys.has(streamKey)) {
      return false;
    }
    immediatelyFlushedStreamKeys.add(streamKey);
    return true;
  }

  if (event.type !== "thread.message-sent" || event.payload.role !== "assistant") {
    return false;
  }

  if (!event.payload.streaming) {
    immediatelyFlushedStreamKeys.delete(`assistant:${event.payload.messageId}`);
    return false;
  }

  const streamKey = `assistant:${event.payload.messageId}`;
  if (immediatelyFlushedStreamKeys.has(streamKey)) {
    return false;
  }

  immediatelyFlushedStreamKeys.add(streamKey);
  return true;
}

function clearReasoningFlushKeysForThread(keys: Set<string>, threadId: ThreadId): void {
  const prefix = `reasoning:${threadId}:`;
  for (const key of keys) {
    if (key.startsWith(prefix)) {
      keys.delete(key);
    }
  }
}

export function isThreadDetailEventForThread(
  event: OrchestrationEvent,
  threadId: ThreadId,
): boolean {
  if (event.aggregateKind !== "thread" || event.aggregateId !== threadId) {
    return false;
  }
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.conversation-rolled-back" ||
    event.type === "thread.session-set" ||
    event.type === "thread.meta-updated" ||
    event.type === "thread.archived" ||
    event.type === "thread.unarchived"
  );
}

export function shouldPollThreadDetailCatchup(threadId: ThreadId): boolean {
  const thread = getThreadFromState(useStore.getState(), threadId);
  return (
    thread?.session?.orchestrationStatus === "running" || thread?.latestTurn?.state === "running"
  );
}
