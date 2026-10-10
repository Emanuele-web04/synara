import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderRuntimeEvent } from "./providerRuntime";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("decodes user-input.requested with structured questions", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-2",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow edits in workspace only",
              },
              {
                label: "danger-full-access",
                description: "Allow unrestricted access",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.id).toBe("sandbox_mode");
    expect(parsed.payload.questions[0]?.options).toHaveLength(2);
  });

  it("rejects legacy message.delta type", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "message.delta",
        eventId: "event-4",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        payload: { delta: "legacy" },
      }),
    ).toThrow();
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });

  it("decodes item.completed with raw (untrimmed) tool output in detail", () => {
    // Tool output legitimately carries leading/trailing whitespace; the durable
    // journal must not reject it (previously quarantined with
    // "Expected a string with no leading or trailing whitespace").
    const rawOutput = "COMMAND   PID  USER   FD   TYPE\nbun.exe 33263 zachz   10u  IPv4\ndone\n";
    const parsed = decodeRuntimeEvent({
      type: "item.completed",
      eventId: "event-tool-1",
      provider: "pi",
      sessionId: "runtime-session-4",
      createdAt: "2026-02-28T00:00:05.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "bash",
        detail: rawOutput,
      },
    });

    expect(parsed.type).toBe("item.completed");
    if (parsed.type !== "item.completed") {
      throw new Error("expected item.completed");
    }
    expect(parsed.payload.detail).toBe(rawOutput);
  });
});
