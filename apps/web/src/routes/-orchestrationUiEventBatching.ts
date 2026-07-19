import type { OrchestrationEvent } from "@synara/contracts";

export const ORCHESTRATION_UI_EVENT_FLUSH_MS = 160;

const IMMEDIATE_ASSISTANT_FLUSH_ID_LIMIT = 512;

export function coalesceOrchestrationUiEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  if (events.length < 2) return [...events];

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

export function shouldFlushOrchestrationUiEvents(
  event: OrchestrationEvent,
  pendingEvents: ReadonlyArray<OrchestrationEvent>,
  immediatelyFlushedAssistantMessageIds: Set<string>,
): boolean {
  if (event.type === "thread.activity-appended") return true;
  if (event.type !== "thread.message-sent" || event.payload.role !== "assistant") return false;

  const messageId = event.payload.messageId;
  if (!event.payload.streaming) {
    immediatelyFlushedAssistantMessageIds.delete(messageId);
    return true;
  }
  if (!immediatelyFlushedAssistantMessageIds.has(messageId)) {
    addBoundedSetValue(immediatelyFlushedAssistantMessageIds, messageId);
    return true;
  }

  const pendingText = pendingEvents
    .flatMap((pendingEvent) =>
      pendingEvent.type === "thread.message-sent" &&
      pendingEvent.payload.role === "assistant" &&
      pendingEvent.payload.messageId === messageId
        ? [pendingEvent.payload.text]
        : [],
    )
    .join("");
  return (
    pendingText.length >= 64 ||
    (pendingText.length >= 24 && /(?:\n|[.!?…:;]\s*)$/.test(pendingText))
  );
}

function addBoundedSetValue(set: Set<string>, value: string): void {
  if (set.has(value)) set.delete(value);
  while (set.size >= IMMEDIATE_ASSISTANT_FLUSH_ID_LIMIT) {
    const oldestValue = set.values().next().value;
    if (oldestValue === undefined) break;
    set.delete(oldestValue);
  }
  set.add(value);
}
