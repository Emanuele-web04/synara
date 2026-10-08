// FILE: CursorAdapter.test.ts
// Purpose: Characterizes Cursor terminal-event account identity.
// Layer: Provider adapter tests

import {
  EventId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type * as Acp from "@agentclientprotocol/sdk";

import { cursorPromptUsageSnapshot, stampCursorTerminalEventInstance } from "./CursorAdapter.ts";

describe("CursorAdapter terminal event identity", () => {
  it("keeps the stopped account identity after the thread is rebound to another account", () => {
    const accountA = "cursor_account_a" as ProviderInstanceId;
    const accountB = "cursor_account_b" as ProviderInstanceId;
    const terminalEvent: ProviderRuntimeEvent = {
      type: "session.exited",
      eventId: EventId.makeUnsafe("cursor-exit-a"),
      provider: "cursor",
      threadId: ThreadId.makeUnsafe("shared-cursor-thread"),
      createdAt: "2026-07-11T00:00:00.000Z",
      payload: { exitKind: "graceful" },
    };

    const stamped = stampCursorTerminalEventInstance(terminalEvent, accountA);

    expect(accountB).not.toBe(accountA);
    expect(stamped.providerInstanceId).toBe(accountA);
  });
});

describe("CursorAdapter ACP usage", () => {
  it("projects cumulative PromptResponse usage into profile token accounting", () => {
    expect(
      cursorPromptUsageSnapshot({
        totalTokens: 1_234.9,
        inputTokens: 900.2,
        outputTokens: 200.8,
        thoughtTokens: 100.4,
        cachedReadTokens: 30.6,
        cachedWriteTokens: 3.2,
      } satisfies Acp.Usage),
    ).toEqual({
      usedTokens: 0,
      totalProcessedTokens: 1_234,
      inputTokens: 900,
      outputTokens: 200,
      reasoningOutputTokens: 100,
      cachedInputTokens: 30,
      cacheCreationInputTokens: 3,
    });
  });

  it("ignores missing or invalid cumulative usage", () => {
    expect(cursorPromptUsageSnapshot(undefined)).toBeUndefined();
    expect(
      cursorPromptUsageSnapshot({
        totalTokens: Number.NaN,
        inputTokens: 0,
        outputTokens: 0,
      } satisfies Acp.Usage),
    ).toBeUndefined();
    expect(
      cursorPromptUsageSnapshot({
        totalTokens: 10,
        inputTokens: -1,
        outputTokens: 2,
      } satisfies Acp.Usage),
    ).toEqual({
      usedTokens: 0,
      totalProcessedTokens: 10,
      outputTokens: 2,
    });
  });

  it("preserves the latest context occupancy when adding cumulative spend", () => {
    expect(
      cursorPromptUsageSnapshot(
        { totalTokens: 400, inputTokens: 350, outputTokens: 50 } satisfies Acp.Usage,
        {
          usedTokens: 32_000,
          usedPercent: 12.5,
          maxTokens: 256_000,
          compactsAutomatically: true,
        },
      ),
    ).toMatchObject({
      usedTokens: 32_000,
      usedPercent: 12.5,
      maxTokens: 256_000,
      totalProcessedTokens: 400,
    });
  });
});
