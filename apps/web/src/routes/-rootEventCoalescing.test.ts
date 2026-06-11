// FILE: -rootEventCoalescing.test.ts
// Purpose: Covers root event coalescing decisions for streaming transcript and work-log updates.
// Layer: Route utility unit tests
// Depends on: root event coalescing predicates and Vitest assertions.

import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { shouldFlushDomainEventImmediately } from "./-rootEventCoalescing";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("thread-2");
const TURN_ID = TurnId.makeUnsafe("turn-1");
const OTHER_TURN_ID = TurnId.makeUnsafe("turn-2");
const NOW = "2026-06-10T12:00:00.000Z";

type ThreadActivityAppendedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.activity-appended" }
>;
type ThreadMessageSentEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

describe("shouldFlushDomainEventImmediately", () => {
  it("flushes only the first reasoning delta for each thread turn immediately", () => {
    const flushedKeys = new Set<string>();

    expect(
      shouldFlushDomainEventImmediately(
        reasoningDeltaEvent({ eventId: "event-reasoning-1", activityId: "activity-reasoning-1" }),
        flushedKeys,
      ),
    ).toBe(true);
    expect(
      shouldFlushDomainEventImmediately(
        reasoningDeltaEvent({ eventId: "event-reasoning-2", activityId: "activity-reasoning-2" }),
        flushedKeys,
      ),
    ).toBe(false);
    expect(
      shouldFlushDomainEventImmediately(
        reasoningDeltaEvent({
          eventId: "event-reasoning-other-turn",
          activityId: "activity-reasoning-other-turn",
          turnId: OTHER_TURN_ID,
        }),
        flushedKeys,
      ),
    ).toBe(true);
    expect(
      shouldFlushDomainEventImmediately(
        reasoningDeltaEvent({
          eventId: "event-reasoning-other-thread",
          activityId: "activity-reasoning-other-thread",
          threadId: OTHER_THREAD_ID,
        }),
        flushedKeys,
      ),
    ).toBe(true);
  });

  it("clears reasoning flush keys for the thread when a user message starts a new turn", () => {
    const flushedKeys = new Set<string>();

    expect(
      shouldFlushDomainEventImmediately(
        reasoningDeltaEvent({ eventId: "event-reasoning-1", activityId: "activity-reasoning-1" }),
        flushedKeys,
      ),
    ).toBe(true);
    expect(
      shouldFlushDomainEventImmediately(
        userMessageEvent({ eventId: "event-user-message", messageId: "message-user" }),
        flushedKeys,
      ),
    ).toBe(false);
    expect(
      shouldFlushDomainEventImmediately(
        reasoningDeltaEvent({ eventId: "event-reasoning-2", activityId: "activity-reasoning-2" }),
        flushedKeys,
      ),
    ).toBe(true);
  });

  it("flushes and resets turnless reasoning deltas by thread", () => {
    const flushedKeys = new Set<string>();

    expect(
      shouldFlushDomainEventImmediately(
        reasoningDeltaEvent({
          eventId: "event-turnless-reasoning-1",
          activityId: "activity-turnless-reasoning-1",
          turnId: null,
        }),
        flushedKeys,
      ),
    ).toBe(true);
    expect(
      shouldFlushDomainEventImmediately(
        reasoningDeltaEvent({
          eventId: "event-turnless-reasoning-2",
          activityId: "activity-turnless-reasoning-2",
          turnId: null,
        }),
        flushedKeys,
      ),
    ).toBe(false);
    expect(
      shouldFlushDomainEventImmediately(
        userMessageEvent({ eventId: "event-turnless-user-message", messageId: "message-user" }),
        flushedKeys,
      ),
    ).toBe(false);
    expect(
      shouldFlushDomainEventImmediately(
        reasoningDeltaEvent({
          eventId: "event-turnless-reasoning-3",
          activityId: "activity-turnless-reasoning-3",
          turnId: null,
        }),
        flushedKeys,
      ),
    ).toBe(true);
  });

  it("keeps assistant streaming first-delta behavior unchanged", () => {
    const flushedKeys = new Set<string>();

    expect(
      shouldFlushDomainEventImmediately(
        assistantMessageEvent({
          eventId: "event-assistant-streaming",
          messageId: "message-assistant",
          streaming: true,
        }),
        flushedKeys,
      ),
    ).toBe(true);
    expect(
      shouldFlushDomainEventImmediately(
        assistantMessageEvent({
          eventId: "event-assistant-streaming-next",
          messageId: "message-assistant",
          streaming: true,
        }),
        flushedKeys,
      ),
    ).toBe(false);
    expect(
      shouldFlushDomainEventImmediately(
        assistantMessageEvent({
          eventId: "event-assistant-complete",
          messageId: "message-assistant",
          streaming: false,
        }),
        flushedKeys,
      ),
    ).toBe(false);
    expect(
      shouldFlushDomainEventImmediately(
        assistantMessageEvent({
          eventId: "event-assistant-streaming-again",
          messageId: "message-assistant",
          streaming: true,
        }),
        flushedKeys,
      ),
    ).toBe(true);
  });
});

function reasoningDeltaEvent(input: {
  eventId: string;
  activityId: string;
  threadId?: ThreadId | undefined;
  turnId?: TurnId | null | undefined;
}): ThreadActivityAppendedEvent {
  const threadId = input.threadId ?? THREAD_ID;
  return {
    ...baseThreadEventFields(input.eventId, threadId),
    type: "thread.activity-appended",
    payload: {
      threadId,
      activity: reasoningDeltaActivity(
        input.activityId,
        input.turnId === undefined ? TURN_ID : input.turnId,
      ),
    },
  };
}

function reasoningDeltaActivity(
  activityId: string,
  turnId: TurnId | null,
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(activityId),
    tone: "info",
    kind: "reasoning.delta",
    summary: "Thinking",
    payload: {},
    turnId,
    sequence: 1,
    createdAt: NOW,
  };
}

function userMessageEvent(input: {
  eventId: string;
  messageId: string;
  threadId?: ThreadId | undefined;
}): ThreadMessageSentEvent {
  const threadId = input.threadId ?? THREAD_ID;
  return {
    ...baseThreadEventFields(input.eventId, threadId),
    type: "thread.message-sent",
    payload: {
      threadId,
      messageId: MessageId.makeUnsafe(input.messageId),
      role: "user",
      text: "Review this",
      attachments: [],
      turnId: null,
      streaming: false,
      source: "native",
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

function assistantMessageEvent(input: {
  eventId: string;
  messageId: string;
  streaming: boolean;
  threadId?: ThreadId | undefined;
}): ThreadMessageSentEvent {
  const threadId = input.threadId ?? THREAD_ID;
  return {
    ...baseThreadEventFields(input.eventId, threadId),
    type: "thread.message-sent",
    payload: {
      threadId,
      messageId: MessageId.makeUnsafe(input.messageId),
      role: "assistant",
      text: input.streaming ? "Working" : "Working through it.",
      attachments: [],
      turnId: TURN_ID,
      streaming: input.streaming,
      source: "native",
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

function baseThreadEventFields(
  eventId: string,
  threadId: ThreadId,
): Omit<ThreadMessageSentEvent, "type" | "payload"> {
  return {
    sequence: 1,
    eventId: EventId.makeUnsafe(eventId),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  };
}
