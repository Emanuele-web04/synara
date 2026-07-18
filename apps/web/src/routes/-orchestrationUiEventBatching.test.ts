import type { OrchestrationEvent } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  coalesceOrchestrationUiEvents,
  ORCHESTRATION_UI_EVENT_FLUSH_MS,
  shouldFlushOrchestrationUiEvents,
} from "./-orchestrationUiEventBatching";

function messageEvent(text: string, streaming = true): OrchestrationEvent {
  return {
    type: "thread.message-sent",
    payload: {
      threadId: "thread-1",
      messageId: "message-1",
      role: "assistant",
      text,
      streaming,
    },
  } as OrchestrationEvent;
}

function activityEvent(): OrchestrationEvent {
  return {
    type: "thread.activity-appended",
    payload: { threadId: "thread-1", activity: { kind: "tool.started" } },
  } as OrchestrationEvent;
}

describe("orchestration UI event batching", () => {
  it("uses the phrase batching cadence", () => {
    expect(ORCHESTRATION_UI_EVENT_FLUSH_MS).toBe(160);
  });

  it("flushes the first assistant delta immediately, then waits for a phrase", () => {
    const flushedMessageIds = new Set<string>();
    const first = messageEvent("I’ll start ");
    const second = messageEvent("by checking ");

    expect(shouldFlushOrchestrationUiEvents(first, [first], flushedMessageIds)).toBe(true);
    expect(shouldFlushOrchestrationUiEvents(second, [second], flushedMessageIds)).toBe(false);
  });

  it("flushes phrase boundaries, tool activity, and completion immediately", () => {
    const flushedMessageIds = new Set(["message-1"]);
    const phrase = messageEvent("by checking the repository. ");
    const completion = messageEvent("", false);

    expect(shouldFlushOrchestrationUiEvents(phrase, [phrase], flushedMessageIds)).toBe(true);
    expect(shouldFlushOrchestrationUiEvents(activityEvent(), [], flushedMessageIds)).toBe(true);
    expect(shouldFlushOrchestrationUiEvents(completion, [completion], flushedMessageIds)).toBe(
      true,
    );
    expect(flushedMessageIds.has("message-1")).toBe(false);
  });

  it("coalesces queued deltas without changing completion text", () => {
    const first = messageEvent("queued ");
    const second = messageEvent("phrase");
    const completion = messageEvent("queued phrase", false);
    const deltas = coalesceOrchestrationUiEvents([first, second])[0];
    const completed = coalesceOrchestrationUiEvents([first, completion])[0];

    expect(deltas?.type).toBe("thread.message-sent");
    expect(completed?.type).toBe("thread.message-sent");
    if (deltas?.type !== "thread.message-sent" || completed?.type !== "thread.message-sent") {
      throw new Error("Expected coalesced message events");
    }
    expect(deltas.payload.text).toBe("queued phrase");
    expect(completed.payload.text).toBe("queued phrase");
  });
});
