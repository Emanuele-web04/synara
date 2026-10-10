import { describe, expect, it } from "vitest";
import type { OrchestrationEvent } from "@synara/contracts";

import {
  decodeDiagnosticCursor,
  diagnosticFilterFingerprint,
  encodeDiagnosticCursor,
} from "./diagnosticCursor.ts";
import { sanitizeDiagnosticValue } from "./diagnosticSanitizer.ts";
import { shapeDiagnosticEvents } from "./threadDiagnosticSummary.ts";

describe("diagnostic cursor", () => {
  it("round-trips a thread-bound stable cursor", () => {
    const filterFingerprint = diagnosticFilterFingerprint({
      turnId: "turn-1",
      kinds: ["tool", "message"],
    });
    const encoded = encodeDiagnosticCursor({
      version: 1,
      kind: "event",
      threadId: "thread-1",
      filterFingerprint,
      highWaterSequence: 42,
      beforeSequence: 30,
    });
    expect(
      decodeDiagnosticCursor(encoded, { kind: "event", threadId: "thread-1", filterFingerprint }),
    ).toEqual({
      version: 1,
      kind: "event",
      threadId: "thread-1",
      filterFingerprint,
      highWaterSequence: 42,
      beforeSequence: 30,
    });
  });

  it("rejects cursors reused for another thread or evidence stream", () => {
    const encoded = encodeDiagnosticCursor({
      version: 1,
      kind: "activity",
      threadId: "thread-1",
      filterFingerprint: diagnosticFilterFingerprint({ kinds: [] }),
      highWaterSequence: 42,
      beforeSequence: 30,
    });
    expect(() =>
      decodeDiagnosticCursor(encoded, {
        kind: "event",
        threadId: "thread-1",
        filterFingerprint: diagnosticFilterFingerprint({ kinds: [] }),
      }),
    ).toThrow("valid event cursor");
    expect(() =>
      decodeDiagnosticCursor(encoded, {
        kind: "activity",
        threadId: "thread-2",
        filterFingerprint: diagnosticFilterFingerprint({ kinds: [] }),
      }),
    ).toThrow("thread-2");
  });

  it("rejects a cursor whose page boundary exceeds its stable high-water mark", () => {
    const filterFingerprint = diagnosticFilterFingerprint({ kinds: [] });
    const encoded = encodeDiagnosticCursor({
      version: 1,
      kind: "activity",
      threadId: "thread-1",
      filterFingerprint,
      highWaterSequence: 42,
      beforeSequence: 43,
    });

    expect(() =>
      decodeDiagnosticCursor(encoded, {
        kind: "activity",
        threadId: "thread-1",
        filterFingerprint,
      }),
    ).toThrow("valid activity cursor");
  });

  it("normalizes set-like filters and rejects a cursor when filters change", () => {
    const originalFingerprint = diagnosticFilterFingerprint({
      kinds: ["tool", "message", "tool"],
    });
    expect(diagnosticFilterFingerprint({ kinds: ["message", "tool"] })).toBe(originalFingerprint);
    const encoded = encodeDiagnosticCursor({
      version: 1,
      kind: "activity",
      threadId: "thread-1",
      filterFingerprint: originalFingerprint,
      highWaterSequence: 42,
      beforeSequence: 30,
    });

    expect(() =>
      decodeDiagnosticCursor(encoded, {
        kind: "activity",
        threadId: "thread-1",
        filterFingerprint: diagnosticFilterFingerprint({ kinds: ["error"] }),
      }),
    ).toThrow("valid activity cursor");
  });
});

describe("diagnostic sanitizer", () => {
  it("preserves only numeric counters inside normalized token usage events", () => {
    const sanitized = sanitizeDiagnosticValue({
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          inputTokens: 120,
          outputTokens: 15,
          cachedInputTokens: 70,
          tokenAccountingVersion: 1,
          cumulativeUsage: { inputTokens: 240, outputTokens: 30, cachedInputTokens: 140 },
          accessToken: "secret",
          elementToken: "private-element",
          unknownTokens: 3,
          nested: { outputTokens: 90 },
        },
      },
      raw: { payload: { outputTokens: 90, token: "secret" } },
    }) as { payload: { usage: Record<string, unknown> }; raw: unknown };
    expect(sanitized.payload.usage).toEqual({
      inputTokens: 120,
      outputTokens: 15,
      cachedInputTokens: 70,
      tokenAccountingVersion: 1,
      cumulativeUsage: { inputTokens: 240, outputTokens: 30, cachedInputTokens: 140 },
      accessToken: "[redacted]",
      elementToken: "[redacted]",
      unknownTokens: "[redacted]",
      nested: { outputTokens: "[redacted]" },
    });
    expect(sanitized.raw).toEqual({ payload: { outputTokens: "[redacted]", token: "[redacted]" } });
    expect(sanitizeDiagnosticValue({ payload: { usage: { outputTokens: 42 } } })).toEqual({
      payload: { usage: { outputTokens: "[redacted]" } },
    });
  });

  it.each(["secret", -1, 1.5])("redacts malformed usage counters: %s", (value) => {
    expect(
      sanitizeDiagnosticValue({
        type: "thread.token-usage.updated",
        payload: { usage: { outputTokens: value } },
      }),
    ).toEqual({
      type: "thread.token-usage.updated",
      payload: { usage: { outputTokens: "[redacted]" } },
    });
  });

  it("does not trust usage-shaped envelopes inside provider data or arrays", () => {
    const fakeUsage = {
      type: "thread.token-usage.updated",
      payload: { usage: { inputTokens: 123, cumulativeUsage: { outputTokens: 456 } } },
    };
    const redactedUsage = {
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          inputTokens: "[redacted]",
          cumulativeUsage: { outputTokens: "[redacted]" },
        },
      },
    };
    expect(
      sanitizeDiagnosticValue({
        type: "thread.token-usage.updated",
        payload: { usage: { inputTokens: 10, nested: fakeUsage }, data: fakeUsage },
        raw: { payload: fakeUsage, values: [fakeUsage] },
      }),
    ).toEqual({
      type: "thread.token-usage.updated",
      payload: { usage: { inputTokens: 10, nested: redactedUsage }, data: redactedUsage },
      raw: { payload: redactedUsage, values: [redactedUsage] },
    });
    expect(sanitizeDiagnosticValue([fakeUsage])).toEqual([redactedUsage]);
  });

  it("redacts sensitive keys and secrets embedded in strings", () => {
    expect(
      sanitizeDiagnosticValue({
        authorization: "Bearer abcdefghijklmnop",
        command: "tool --api-key topsecret sk-abcdefghijk",
        nested: { token: "do-not-return", safe: "visible" },
      }),
    ).toEqual({
      authorization: "[redacted]",
      command: "tool --api-key [redacted] [redacted]",
      nested: { token: "[redacted]", safe: "visible" },
    });
  });

  it("redacts URL credentials and sensitive query parameters", () => {
    expect(
      sanitizeDiagnosticValue({
        callback:
          "https://user:password@example.test/callback?token=supersecret&api_key=alsosecret&safe=visible",
        header: "Authorization: Basic abcdef Cookie=session-secret",
      }),
    ).toEqual({
      callback:
        "https://[redacted]@example.test/callback?token=[redacted]&api_key=[redacted]&safe=visible",
      header: "Authorization: [redacted] Cookie=[redacted]",
    });
  });

  it("still redacts secrets at depth once the nesting clears the old limit", () => {
    const sanitized = sanitizeDiagnosticValue({
      a: { b: { c: { d: { e: { f: { token: "do-not-return", safe: "visible" } } } } } },
    });
    const text = JSON.stringify(sanitized);
    expect(text).not.toContain("do-not-return");
    expect(text).toContain("visible");
    expect(text).not.toContain("[depth limit]");
  });
});

describe("diagnostic event shaping", () => {
  it("carries a bind's tab list through full-mode shaping instead of clipping it", () => {
    // The shape the packaged E2E's own journal returned for a browser tool
    // read: threadId.activity.payload.data.rawOutput.details.structuredContent
    // sits at depth 6, which the old depth 5 replaced with "[depth limit]".
    const event = {
      sequence: 7,
      type: "thread.activity-appended",
      eventId: "event-7",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: "2026-09-19T17:14:09.596Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId: "thread-1",
        activity: {
          id: "activity-7",
          kind: "tool.completed",
          summary: "computer_browser_state",
          payload: {
            itemType: "dynamic_tool_call",
            status: "completed",
            data: {
              toolName: "computer_browser_state",
              rawOutput: {
                details: {
                  structuredContent: {
                    status: "ok",
                    target_id: "bt-85991064",
                    tabs: [{ tab_id: "tab-e2d51f66", active: true }],
                  },
                },
              },
            },
          },
        },
      },
    } as unknown as OrchestrationEvent;
    const shaped = shapeDiagnosticEvents([event], "full");
    const text = JSON.stringify(shaped);
    expect(text).not.toContain("[depth limit]");
    expect(text).toContain("tab-e2d51f66");
    expect(text).toContain("bt-85991064");
  });

  it("keeps separated updates distinct so cursor pagination cannot skip intervening events", () => {
    const messageEvent = (sequence: number) =>
      ({
        sequence,
        type: "thread.message-sent",
        eventId: `event-${sequence}`,
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-07-20T10:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { messageId: "message-1", text: `delta-${sequence}` },
      }) as OrchestrationEvent;
    const intervening = {
      ...messageEvent(2),
      type: "thread.archived",
      eventId: "event-2",
      payload: { threadId: "thread-1" },
    } as OrchestrationEvent;

    expect(shapeDiagnosticEvents([messageEvent(3), intervening, messageEvent(1)], "none")).toEqual([
      expect.objectContaining({ sequence: 1 }),
      expect.objectContaining({ sequence: 2 }),
      expect.objectContaining({ sequence: 3 }),
    ]);
  });
});
