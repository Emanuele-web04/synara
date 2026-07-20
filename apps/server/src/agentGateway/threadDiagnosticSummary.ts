import type { OrchestrationEvent } from "@synara/contracts";

import { sanitizeDiagnosticValue } from "./diagnosticSanitizer.ts";
import { readNumberArg } from "./toolInput.ts";

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

export function readDiagnosticPageLimit(args: Record<string, unknown>): number {
  return Math.max(
    1,
    Math.min(Math.floor(readNumberArg(args, "limit") ?? DEFAULT_PAGE_LIMIT), MAX_PAGE_LIMIT),
  );
}

export function diagnosticEventMessageId(event: OrchestrationEvent): string | null {
  if (
    event.type !== "thread.message-sent" ||
    typeof event.payload !== "object" ||
    event.payload === null
  ) {
    return null;
  }
  const payload = event.payload as Record<string, unknown>;
  const message = payload.message;
  if (typeof message === "object" && message !== null) {
    const messageId = (message as Record<string, unknown>).messageId;
    return typeof messageId === "string" ? messageId : null;
  }
  return typeof payload.messageId === "string" ? payload.messageId : null;
}

export interface DiagnosticEventGroup {
  readonly event: OrchestrationEvent;
  readonly coalescedEventCount: number;
  readonly oldestSequence: number;
}

export function groupDiagnosticEvents(
  eventsNewestFirst: ReadonlyArray<OrchestrationEvent>,
): ReadonlyArray<DiagnosticEventGroup> {
  const groups: Array<DiagnosticEventGroup & { readonly messageId: string | null }> = [];
  for (const event of eventsNewestFirst) {
    const messageId = diagnosticEventMessageId(event);
    const previous = groups[groups.length - 1];
    if (messageId !== null && previous?.messageId === messageId) {
      groups[groups.length - 1] = {
        ...previous,
        coalescedEventCount: previous.coalescedEventCount + 1,
        oldestSequence: Math.min(previous.oldestSequence, event.sequence),
      };
      continue;
    }
    groups.push({ event, messageId, coalescedEventCount: 1, oldestSequence: event.sequence });
  }
  return groups;
}

function summarizeEventPayload(event: OrchestrationEvent): unknown {
  if (typeof event.payload !== "object" || event.payload === null) return undefined;
  const payload = event.payload as Record<string, unknown>;
  const message =
    typeof payload.message === "object" && payload.message !== null
      ? (payload.message as Record<string, unknown>)
      : null;
  const activity =
    typeof payload.activity === "object" && payload.activity !== null
      ? (payload.activity as Record<string, unknown>)
      : null;
  return {
    keys: Object.keys(payload).slice(0, 30),
    ...(typeof payload.turnId === "string" ? { turnId: payload.turnId } : {}),
    ...(typeof payload.state === "string" ? { state: payload.state } : {}),
    ...(message
      ? {
          message: {
            messageId: typeof message.messageId === "string" ? message.messageId : null,
            role: typeof message.role === "string" ? message.role : null,
            textChars: typeof message.text === "string" ? message.text.length : null,
            isStreaming: typeof message.isStreaming === "boolean" ? message.isStreaming : null,
          },
        }
      : {}),
    ...(activity
      ? {
          activity: {
            kind: typeof activity.kind === "string" ? activity.kind : null,
            summary: typeof activity.summary === "string" ? activity.summary : null,
          },
        }
      : {}),
  };
}

export function shapeDiagnosticEvents(
  eventsNewestFirst: ReadonlyArray<OrchestrationEvent>,
  payloadMode: "none" | "summary" | "full",
) {
  return groupDiagnosticEvents(eventsNewestFirst)
    .map(({ event, coalescedEventCount }) => {
      const messageId = diagnosticEventMessageId(event);
      return {
        sequence: event.sequence,
        eventId: event.eventId,
        type: event.type,
        occurredAt: event.occurredAt,
        commandId: event.commandId,
        causationEventId: event.causationEventId,
        correlationId: event.correlationId,
        ...(messageId && coalescedEventCount > 1 ? { coalescedEventCount } : {}),
        ...(payloadMode === "none"
          ? {}
          : {
              payload:
                payloadMode === "full"
                  ? sanitizeDiagnosticValue(event.payload)
                  : summarizeEventPayload(event),
            }),
      };
    })
    .reverse();
}
