import type { OrchestrationEvent } from "@synara/contracts";

type ThreadMessageSentEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

function mergeThreadMessageSentEvents(
  previous: ThreadMessageSentEvent,
  event: ThreadMessageSentEvent,
): ThreadMessageSentEvent {
  return {
    ...event,
    payload: {
      ...event.payload,
      attachments: event.payload.attachments ?? previous.payload.attachments,
      skills: event.payload.skills ?? previous.payload.skills,
      mentions: event.payload.mentions ?? previous.payload.mentions,
      createdAt: previous.payload.createdAt,
      text: previous.payload.text + event.payload.text,
    },
  };
}

// only unrelated threads may intervene between merged deltas — every other event in the same thread is an ordering barrier
export function coalesceOrchestrationUiEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  const coalesced: OrchestrationEvent[] = [];
  const lastSlotByThread = new Map<string, number>();
  for (const event of events) {
    if (!("threadId" in event.payload)) {
      lastSlotByThread.clear();
    } else {
      const threadId = event.payload.threadId;
      const slot = lastSlotByThread.get(threadId);
      const previous = slot === undefined ? undefined : coalesced[slot];
      if (
        event.type === "thread.message-sent" &&
        previous?.type === "thread.message-sent" &&
        previous.payload.messageId === event.payload.messageId &&
        previous.payload.turnId === event.payload.turnId &&
        previous.payload.role === event.payload.role &&
        previous.payload.streaming &&
        event.payload.streaming
      ) {
        coalesced[slot!] = mergeThreadMessageSentEvents(previous, event);
        continue;
      }
      lastSlotByThread.set(threadId, coalesced.length);
    }
    coalesced.push(event);
  }
  return coalesced;
}
