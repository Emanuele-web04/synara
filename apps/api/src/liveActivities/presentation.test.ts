import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { LiveActivityHostSnapshot } from "@synara/contracts";
import { liveActivityContent } from "./presentation";

const startedAt = 1_790_000_000;
const resetAt = startedAt + 3_600;

describe("ActivityKit recovery wire", () => {
  it("keeps waits and admitted resumptions ongoing without inventing a running clock", () => {
    const result = liveActivityContent([
      { id: "original-watch", state: "usageLimit", startedAt, usageLimitResetAt: resetAt },
      { id: "resuming-watch", state: "resuming", startedAt, usageLimitResetAt: resetAt },
    ]);
    expect(result).toEqual({
      ongoing: true,
      content: {
        runningConversations: [
          {
            id: "original-watch",
            title: "Synara task",
            detail: "Synara",
            state: "Usage limit",
            usageLimitResetAt: 811696400,
          },
          {
            id: "resuming-watch",
            title: "Synara task",
            detail: "Synara",
            state: "Resuming on computer",
          },
        ],
        completedConversations: [],
        failedConversations: [],
      },
    });
  });

  it("restores the actual resumed start and settles only the eventual outcome", () => {
    expect(
      liveActivityContent([{ id: "original-watch", state: "running", startedAt }]),
    ).toMatchObject({
      ongoing: true,
      content: { runningConversations: [{ state: "Running", runningStartedAt: 811692800 }] },
    });
    expect(
      liveActivityContent([{ id: "original-watch", state: "ready", startedAt }]),
    ).toMatchObject({
      ongoing: false,
      content: {
        runningConversations: [],
        completedConversations: [{ state: "Ready" }],
        failedConversations: [],
      },
    });
    expect(liveActivityContent([{ id: "original-watch", state: "stopped" }])).toEqual({
      ongoing: false,
      content: { runningConversations: [], completedConversations: [], failedConversations: [] },
    });
  });

  it("accepts additive host recovery metadata while preserving exact source identity", () => {
    const snapshot = Schema.decodeUnknownSync(LiveActivityHostSnapshot)({
      sequence: 3,
      turns: [
        {
          threadId: "thread",
          turnId: "original-turn",
          effectiveTurnId: "recorded-resumed-turn",
          state: "usageLimit",
          usageLimitResetAt: resetAt,
        },
      ],
    });
    expect(snapshot.turns[0]?.turnId).toBe("original-turn");
    expect(snapshot.turns[0]).not.toHaveProperty("startedAt");
  });
});
