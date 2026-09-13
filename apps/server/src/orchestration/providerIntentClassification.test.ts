import { EventId, ThreadId, type OrchestrationEvent } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  isClaimedProviderIntent,
  isProviderIntentEvent,
  isProviderSideEffectIntent,
  isReplaySafeClaimedProviderIntent,
} from "./providerIntentClassification.ts";

describe("providerIntentClassification", () => {
  it("orders archive cleanup with later provider side effects", () => {
    const threadId = ThreadId.makeUnsafe("thread-provider-intent-archive");
    const event = {
      sequence: 1,
      eventId: EventId.makeUnsafe("event-provider-intent-archive"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.archived",
      occurredAt: "2026-07-23T20:00:00.000Z",
      payload: {
        threadId,
        archivedAt: "2026-07-23T20:00:00.000Z",
        updatedAt: "2026-07-23T20:00:00.000Z",
      },
    } as OrchestrationEvent;

    expect(isProviderIntentEvent(event)).toBe(true);
    if (!isProviderIntentEvent(event)) return;
    expect(isProviderSideEffectIntent(event)).toBe(true);
    expect(isClaimedProviderIntent(event)).toBe(true);
    expect(isReplaySafeClaimedProviderIntent(event)).toBe(true);
  });

  it("treats continuous provider handoff as a claimed side effect", () => {
    const threadId = ThreadId.makeUnsafe("thread-provider-intent-handoff");
    const event = {
      sequence: 2,
      eventId: EventId.makeUnsafe("event-provider-intent-handoff"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.provider-handoff-requested",
      occurredAt: "2026-09-10T10:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId,
        sourceModelSelection: { provider: "claudeAgent", model: "claude-sonnet" },
        targetModelSelection: { provider: "grok", model: "grok-code" },
        createdAt: "2026-09-10T10:00:00.000Z",
      },
    } as OrchestrationEvent;

    expect(isProviderIntentEvent(event)).toBe(true);
    if (!isProviderIntentEvent(event)) return;
    expect(isProviderSideEffectIntent(event)).toBe(true);
    expect(isClaimedProviderIntent(event)).toBe(true);
    expect(isReplaySafeClaimedProviderIntent(event)).toBe(true);
  });
});
