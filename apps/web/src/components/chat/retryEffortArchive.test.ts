import { EventId, MessageId, TurnId, type OrchestrationThreadActivity } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  mergeArchivedRetryEffortVariants,
  resolveDurableRetryEffortVariants,
} from "./retryEffortArchive";

const USER_ID = MessageId.makeUnsafe("user-retry-archive");

function receipt(
  sequence: number,
  sourcePrompt = "Fix the test",
  retryPrompt = sourcePrompt,
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(`archive-${sequence}`),
    kind: "turn.effort-retry.snapshot",
    summary: "Saved previous attempt",
    tone: "info",
    turnId: null,
    sequence,
    sequenceSource: "orchestration",
    createdAt: `2026-10-11T00:0${sequence}:00.000Z`,
    payload: {
      userMessageId: USER_ID,
      sourceUserMessageText: sourcePrompt,
      retryUserMessageText: retryPrompt,
      sourceModelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-8",
        options: { effort: sequence === 1 ? "low" : "high" },
      },
      assistantMessageId: `assistant-${sequence}`,
      assistantMessageText: `Attempt ${sequence}`,
      assistantMessageCreatedAt: `2026-10-11T00:0${sequence}:00.000Z`,
      sourceTurnId: `turn-${sequence}`,
      checkpointTurnCount: 1,
    },
  };
}

describe("durable effort retry archive", () => {
  it("recovers prior answers and explicit effort without any local browser archive", () => {
    const variants = resolveDurableRetryEffortVariants({
      activities: [receipt(1)],
      userMessageId: USER_ID,
      userMessageText: "Fix the test",
    });
    expect(variants).toMatchObject([
      {
        assistantMessageId: "assistant-1",
        turnId: TurnId.makeUnsafe("turn-1"),
        text: "Attempt 1",
        effort: "low",
        provider: "claudeAgent",
        model: "claude-opus-4-8",
      },
    ]);
  });

  it("retains the earlier chain when the recorded retry injects Ultrathink", () => {
    const variants = resolveDurableRetryEffortVariants({
      activities: [receipt(1), receipt(2, "Fix the test", "Ultrathink:\nFix the test")],
      userMessageId: USER_ID,
      userMessageText: "Ultrathink:\nFix the test",
    });
    expect(variants.map((variant) => variant.text)).toEqual(["Attempt 1", "Attempt 2"]);
  });

  it("does not mix prior answers with an ordinary prompt revision or another message", () => {
    const activities = [receipt(1)];
    expect(
      resolveDurableRetryEffortVariants({
        activities,
        userMessageId: USER_ID,
        userMessageText: "A new task",
      }),
    ).toEqual([]);
    expect(
      resolveDurableRetryEffortVariants({
        activities,
        userMessageId: MessageId.makeUnsafe("other-user"),
        userMessageText: "Fix the test",
      }),
    ).toEqual([]);
  });

  it("ignores a malformed receipt while preserving valid earlier history", () => {
    const invalid = {
      ...receipt(2),
      payload: {
        ...(receipt(2).payload as object),
        sourceModelSelection: { provider: "missing", model: "bad" },
      },
    };
    const variants = resolveDurableRetryEffortVariants({
      activities: [receipt(1), invalid],
      userMessageId: USER_ID,
      userMessageText: "Fix the test",
    });
    expect(variants.map((variant) => variant.text)).toEqual(["Attempt 1"]);
  });

  it("recovers independently validated usage, time and cost on the archived variant", () => {
    const original = receipt(1);
    const enriched: OrchestrationThreadActivity = {
      ...original,
      payload: {
        ...(original.payload as object),
        sourceMetrics: {
          inputTokens: 100,
          outputTokens: 25,
          totalTokens: 125,
          durationMs: 2500,
          costUsd: 0.12,
        },
      },
    };
    const variants = resolveDurableRetryEffortVariants({
      activities: [enriched],
      userMessageId: USER_ID,
      userMessageText: "Fix the test",
    });
    expect(variants[0]?.metrics).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      durationMs: 2500,
      costUsd: 0.12,
    });
  });

  it("deduplicates the server receipt with the original browser's richer label", () => {
    const durable = resolveDurableRetryEffortVariants({
      activities: [receipt(1)],
      userMessageId: USER_ID,
      userMessageText: "Fix the test",
    });
    const local = [{ ...durable[0]!, effortLabel: "Low" }];
    expect(mergeArchivedRetryEffortVariants({ durable, local })).toEqual(local);
  });
});
