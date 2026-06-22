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

import {
  coalesceOrchestrationUiEvents,
  detailThreadHasStarted,
  isThreadDetailEventForThread,
  shouldFlushDomainEventImmediately,
  shellThreadHasStarted,
} from "./-rootEventCoalescing";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("thread-2");
const TURN_ID = TurnId.makeUnsafe("turn-1");
const OTHER_TURN_ID = TurnId.makeUnsafe("turn-2");
const NOW = "2026-06-10T12:00:00.000Z";

type ThreadActivityAppendedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.activity-appended" }
>;
type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;
type ThreadMessageSentEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

describe("shouldFlushDomainEventImmediately", () => {
  it("flushes the first reasoning activity of each kind for each thread turn immediately", () => {
    const flushedKeys = new Set<string>();

    expect(
      shouldFlushDomainEventImmediately(
        reasoningDeltaEvent({ eventId: "event-reasoning-1", activityId: "activity-reasoning-1" }),
        flushedKeys,
      ),
    ).toBe(true);
    expect(
      shouldFlushDomainEventImmediately(
        reasoningDeltaEvent({
          eventId: "event-reasoning-2",
          activityId: "activity-reasoning-2",
          kind: "reasoning.progress",
        }),
        flushedKeys,
      ),
    ).toBe(true);
    expect(
      shouldFlushDomainEventImmediately(
        reasoningDeltaEvent({
          eventId: "event-reasoning-3",
          activityId: "activity-reasoning-3",
          kind: "reasoning.progress",
        }),
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

  it("flushes the first tool output stream per item immediately", () => {
    const flushedKeys = new Set<string>();

    expect(
      shouldFlushDomainEventImmediately(
        toolOutputDeltaEvent({ eventId: "event-tool-output-1", activityId: "activity-output-1" }),
        flushedKeys,
      ),
    ).toBe(true);
    expect(
      shouldFlushDomainEventImmediately(
        toolOutputDeltaEvent({ eventId: "event-tool-output-2", activityId: "activity-output-2" }),
        flushedKeys,
      ),
    ).toBe(false);
    expect(
      shouldFlushDomainEventImmediately(
        toolOutputDeltaEvent({
          eventId: "event-tool-output-other-item",
          activityId: "activity-output-other-item",
          itemId: "cmd-2",
        }),
        flushedKeys,
      ),
    ).toBe(true);
    expect(
      shouldFlushDomainEventImmediately(
        userMessageEvent({ eventId: "event-tool-output-user-message", messageId: "message-user" }),
        flushedKeys,
      ),
    ).toBe(false);
    expect(
      shouldFlushDomainEventImmediately(
        toolOutputDeltaEvent({ eventId: "event-tool-output-3", activityId: "activity-output-3" }),
        flushedKeys,
      ),
    ).toBe(true);
  });

  it("keys provider stream flushes by stream kind, item, content, and summary index", () => {
    const flushedKeys = new Set<string>();

    expect(
      shouldFlushDomainEventImmediately(
        streamActivityEvent({
          eventId: "event-provider-content",
          activityId: "activity-provider-content",
          kind: "provider.content.delta",
          payload: {
            streamKind: "unknown",
            itemId: "item-1",
            contentIndex: 0,
            summaryIndex: 0,
            detail: "provider chunk",
          },
        }),
        flushedKeys,
      ),
    ).toBe(true);
    expect(
      shouldFlushDomainEventImmediately(
        streamActivityEvent({
          eventId: "event-provider-content-dupe",
          activityId: "activity-provider-content-dupe",
          kind: "provider.content.delta",
          payload: {
            streamKind: "unknown",
            itemId: "item-1",
            contentIndex: 0,
            summaryIndex: 0,
            detail: "provider chunk two",
          },
        }),
        flushedKeys,
      ),
    ).toBe(false);
    expect(
      shouldFlushDomainEventImmediately(
        streamActivityEvent({
          eventId: "event-provider-content-other-index",
          activityId: "activity-provider-content-other-index",
          kind: "provider.content.delta",
          payload: {
            streamKind: "unknown",
            itemId: "item-1",
            contentIndex: 1,
            summaryIndex: 0,
            detail: "provider chunk other index",
          },
        }),
        flushedKeys,
      ),
    ).toBe(true);
    expect(
      shouldFlushDomainEventImmediately(
        streamActivityEvent({
          eventId: "event-plan-delta",
          activityId: "activity-plan-delta",
          kind: "plan.delta",
          payload: {
            streamKind: "plan_text",
            itemId: "item-1",
            contentIndex: 1,
            summaryIndex: 0,
            detail: "plan chunk",
          },
        }),
        flushedKeys,
      ),
    ).toBe(true);
    expect(
      shouldFlushDomainEventImmediately(
        streamActivityEvent({
          eventId: "event-reasoning-summary",
          activityId: "activity-reasoning-summary",
          kind: "reasoning.delta",
          payload: {
            streamKind: "reasoning_summary_text",
            itemId: "item-1",
            contentIndex: 1,
            summaryIndex: 1,
            detail: "summary chunk",
          },
        }),
        flushedKeys,
      ),
    ).toBe(true);
    expect(
      shouldFlushDomainEventImmediately(
        streamActivityEvent({
          eventId: "event-tool-output-command-kind",
          activityId: "activity-tool-output-command-kind",
          kind: "tool.output.delta",
          payload: {
            streamKind: "command_output",
            itemId: "shared-tool-item",
            detail: "command chunk",
          },
        }),
        flushedKeys,
      ),
    ).toBe(true);
    expect(
      shouldFlushDomainEventImmediately(
        streamActivityEvent({
          eventId: "event-tool-output-file-kind",
          activityId: "activity-tool-output-file-kind",
          kind: "tool.output.delta",
          payload: {
            streamKind: "file_change_output",
            itemId: "shared-tool-item",
            detail: "file chunk",
          },
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

describe("coalesceOrchestrationUiEvents", () => {
  it("coalesces adjacent assistant streaming chunks and preserves first metadata", () => {
    const firstChunk = assistantMessageEvent({
      eventId: "event-assistant-streaming-first",
      messageId: "message-assistant",
      streaming: true,
    });
    const secondChunk = {
      ...assistantMessageEvent({
        eventId: "event-assistant-streaming-second",
        messageId: "message-assistant",
        streaming: true,
      }),
      payload: {
        ...firstChunk.payload,
        text: " through it",
        attachments: undefined,
        createdAt: "2026-06-10T12:00:01.000Z",
        updatedAt: "2026-06-10T12:00:01.000Z",
      },
    } satisfies ThreadMessageSentEvent;

    const coalesced = coalesceOrchestrationUiEvents([firstChunk, secondChunk]);

    expect(coalesced).toHaveLength(1);
    expect((coalesced[0] as ThreadMessageSentEvent).payload.text).toBe("Working through it");
    expect((coalesced[0] as ThreadMessageSentEvent).payload.createdAt).toBe(NOW);
    expect((coalesced[0] as ThreadMessageSentEvent).payload.attachments).toEqual([]);
  });

  it("uses a completed assistant replacement chunk when the final text is non-empty", () => {
    const firstChunk = assistantMessageEvent({
      eventId: "event-assistant-streaming-first",
      messageId: "message-assistant",
      streaming: true,
    });
    const finalChunk = {
      ...assistantMessageEvent({
        eventId: "event-assistant-final",
        messageId: "message-assistant",
        streaming: false,
      }),
      payload: {
        ...firstChunk.payload,
        text: "Final answer",
        streaming: false,
        updatedAt: "2026-06-10T12:00:01.000Z",
      },
    } satisfies ThreadMessageSentEvent;

    const coalesced = coalesceOrchestrationUiEvents([firstChunk, finalChunk]);

    expect(coalesced).toHaveLength(1);
    expect((coalesced[0] as ThreadMessageSentEvent).payload.text).toBe("Final answer");
  });

  it("preserves assistant chunks around interleaved provider-unhandled activity", () => {
    const firstChunk = assistantMessageEvent({
      eventId: "event-assistant-streaming-first",
      messageId: "message-assistant",
      streaming: true,
    });
    const providerUnhandled = providerUnhandledActivityEvent({
      eventId: "event-provider-unhandled",
      activityId: "activity-provider-unhandled",
    });
    const secondChunk = {
      ...assistantMessageEvent({
        eventId: "event-assistant-streaming-second",
        messageId: "message-assistant",
        streaming: true,
      }),
      payload: {
        ...firstChunk.payload,
        text: " through the next chunk",
        updatedAt: "2026-06-10T12:00:01.000Z",
      },
    } satisfies ThreadMessageSentEvent;

    const coalesced = coalesceOrchestrationUiEvents([firstChunk, providerUnhandled, secondChunk]);

    expect(coalesced).toHaveLength(3);
    expect(coalesced.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.activity-appended",
      "thread.message-sent",
    ]);
    expect((coalesced[0] as ThreadMessageSentEvent).payload.text).toBe("Working");
    expect((coalesced[1] as ThreadActivityAppendedEvent).payload.activity.kind).toBe(
      "provider.unhandled",
    );
    expect((coalesced[2] as ThreadMessageSentEvent).payload.text).toBe(" through the next chunk");

    const flushedKeys = new Set<string>();
    expect(shouldFlushDomainEventImmediately(firstChunk, flushedKeys)).toBe(true);
    expect(shouldFlushDomainEventImmediately(providerUnhandled, flushedKeys)).toBe(false);
    expect(shouldFlushDomainEventImmediately(secondChunk, flushedKeys)).toBe(false);
  });
});

describe("thread detail event helpers", () => {
  it("detects started shell and detail threads", () => {
    expect(
      shellThreadHasStarted({
        id: THREAD_ID,
        projectId: "project-1",
        title: "Thread",
        createdAt: NOW,
        updatedAt: NOW,
        latestTurn: null,
        session: null,
      } as never),
    ).toBe(false);
    expect(
      shellThreadHasStarted({
        id: THREAD_ID,
        projectId: "project-1",
        title: "Thread",
        createdAt: NOW,
        updatedAt: NOW,
        latestTurn: { id: TURN_ID },
        session: null,
      } as never),
    ).toBe(true);
    expect(
      detailThreadHasStarted({
        id: THREAD_ID,
        projectId: "project-1",
        title: "Thread",
        createdAt: NOW,
        updatedAt: NOW,
        messages: [{ id: MessageId.makeUnsafe("message-1") }],
        latestTurn: null,
        session: null,
      } as never),
    ).toBe(true);
  });

  it("matches only supported thread detail events for the requested thread", () => {
    expect(
      isThreadDetailEventForThread(
        userMessageEvent({ eventId: "event-user", messageId: "m1" }),
        THREAD_ID,
      ),
    ).toBe(true);
    expect(
      isThreadDetailEventForThread(
        userMessageEvent({
          eventId: "event-user-other-thread",
          messageId: "m2",
          threadId: OTHER_THREAD_ID,
        }),
        THREAD_ID,
      ),
    ).toBe(false);
    expect(
      isThreadDetailEventForThread(
        {
          ...baseThreadEventFields("event-thread-deleted", THREAD_ID),
          type: "thread.deleted",
          payload: {
            threadId: THREAD_ID,
            deletedAt: NOW,
          },
        } satisfies ThreadDeletedEvent,
        THREAD_ID,
      ),
    ).toBe(false);
  });
});

function reasoningDeltaEvent(input: {
  eventId: string;
  activityId: string;
  threadId?: ThreadId | undefined;
  turnId?: TurnId | null | undefined;
  kind?: "reasoning.delta" | "reasoning.progress" | undefined;
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
        input.kind ?? "reasoning.delta",
      ),
    },
  };
}

function reasoningDeltaActivity(
  activityId: string,
  turnId: TurnId | null,
  kind: "reasoning.delta" | "reasoning.progress",
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(activityId),
    tone: "info",
    kind,
    summary: "Thinking",
    payload: {},
    turnId,
    sequence: 1,
    createdAt: NOW,
  };
}

function toolOutputDeltaEvent(input: {
  eventId: string;
  activityId: string;
  itemId?: string | undefined;
  threadId?: ThreadId | undefined;
  turnId?: TurnId | null | undefined;
}): ThreadActivityAppendedEvent {
  const threadId = input.threadId ?? THREAD_ID;
  return {
    ...baseThreadEventFields(input.eventId, threadId),
    type: "thread.activity-appended",
    payload: {
      threadId,
      activity: {
        id: EventId.makeUnsafe(input.activityId),
        tone: "tool",
        kind: "tool.output.delta",
        summary: "Command output",
        payload: {
          streamKind: "command_output",
          itemId: input.itemId ?? "cmd-1",
          detail: "chunk",
        },
        turnId: input.turnId === undefined ? TURN_ID : input.turnId,
        sequence: 1,
        createdAt: NOW,
      },
    },
  };
}

function streamActivityEvent(input: {
  eventId: string;
  activityId: string;
  kind: "reasoning.delta" | "tool.output.delta" | "plan.delta" | "provider.content.delta";
  payload: OrchestrationThreadActivity["payload"];
  threadId?: ThreadId | undefined;
  turnId?: TurnId | null | undefined;
}): ThreadActivityAppendedEvent {
  const threadId = input.threadId ?? THREAD_ID;
  return {
    ...baseThreadEventFields(input.eventId, threadId),
    type: "thread.activity-appended",
    payload: {
      threadId,
      activity: {
        id: EventId.makeUnsafe(input.activityId),
        tone: input.kind === "tool.output.delta" ? "tool" : "info",
        kind: input.kind,
        summary: "Stream update",
        payload: input.payload,
        turnId: input.turnId === undefined ? TURN_ID : input.turnId,
        sequence: 1,
        createdAt: NOW,
      },
    },
  };
}

function providerUnhandledActivityEvent(input: {
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
      activity: {
        id: EventId.makeUnsafe(input.activityId),
        tone: "info",
        kind: "provider.unhandled",
        summary: "Unhandled provider event",
        payload: {
          provider: "codex",
          source: "codex.app-server",
          method: "future/event",
          nativeEventName: "future/event",
          preview: "Unhandled Codex future event.",
          reason: "no_mapper",
        },
        turnId: input.turnId === undefined ? TURN_ID : input.turnId,
        sequence: 1,
        createdAt: NOW,
      },
    },
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
