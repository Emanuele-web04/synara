import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ClientOrchestrationCommand } from "./orchestration";
import { DEFAULT_SERVER_SETTINGS_VIEW, ServerSettings } from "./settings";

const decodeClientCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);
const response = {
  type: "thread.claude-cache.respond",
  commandId: "cmd-cache-response",
  threadId: "thread-claude-cache",
  messageId: "message-pending",
  reviewId: "review-1",
  decision: "continue",
  createdAt: "2026-09-16T12:00:00.000Z",
};

describe("Claude cache review client commands", () => {
  it("accepts a decision with review and message identity", () => {
    expect(decodeClientCommand(response)).toEqual(response);
  });

  it("does not accept client-supplied cache observations or turn bypass fields", () => {
    expect(
      decodeClientCommand({
        ...response,
        assessment: { state: "likely-warm", contextTokens: 0 },
        review: { status: "responding", sourceEventSequence: 1 },
        acceptedCacheReviewId: "review-1",
        skipCacheReview: true,
      }),
    ).toEqual(response);
  });

  it.each(["messageId", "reviewId"])("requires the %s of the held request", (field) => {
    const input: Record<string, unknown> = { ...response };
    delete input[field];

    expect(() => decodeClientCommand(input)).toThrow();
  });

  it("does not expose the server-only cache setter to clients", () => {
    expect(() =>
      decodeClientCommand({
        type: "thread.claude-cache.set",
        commandId: "cmd-spoof-cache-clear",
        threadId: "thread-claude-cache",
        review: null,
        expectedReviewId: "review-1",
        createdAt: response.createdAt,
      }),
    ).toThrow();
  });
});

describe("Claude resume review setting", () => {
  it("is off by default, like embedded Claude Code, and can be turned on", () => {
    expect(DEFAULT_SERVER_SETTINGS_VIEW.providers.claudeAgent.confirmColdCacheResume).toBe(false);
    expect(
      Schema.decodeUnknownSync(ServerSettings)({
        providers: { claudeAgent: { confirmColdCacheResume: true } },
      }).providers.claudeAgent.confirmColdCacheResume,
    ).toBe(true);
  });
});
