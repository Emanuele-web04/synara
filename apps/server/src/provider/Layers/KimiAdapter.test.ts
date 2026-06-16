// FILE: KimiAdapter.test.ts
// Purpose: Covers Kimi-specific adapter guards that keep resumed ACP replay out of live turns.
// Layer: Provider adapter tests
// Depends on: KimiAdapter helper exports and shared contract ids.

import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  isRenderableKimiAssistantDelta,
  scopeKimiRuntimeItemIdForTurn,
  scopeKimiToolCallStateForTurn,
} from "./KimiAdapter.ts";

describe("KimiAdapter runtime event scoping", () => {
  it("makes reused ACP assistant segment ids unique per DP turn", () => {
    const providerItemId = "assistant:kimi-session:segment:5";

    expect(scopeKimiRuntimeItemIdForTurn(TurnId.makeUnsafe("turn-a"), providerItemId)).toBe(
      "kimi:turn-a:assistant:kimi-session:segment:5",
    );
    expect(scopeKimiRuntimeItemIdForTurn(TurnId.makeUnsafe("turn-b"), providerItemId)).toBe(
      "kimi:turn-b:assistant:kimi-session:segment:5",
    );
  });

  it("preserves the provider tool id while scoping the runtime item id", () => {
    const scoped = scopeKimiToolCallStateForTurn(TurnId.makeUnsafe("turn-a"), {
      toolCallId: "call-1",
      kind: "execute",
      status: "completed",
      title: "Ran command",
      data: {
        toolCallId: "call-1",
      },
    });

    expect(scoped.toolCallId).toBe("kimi:turn-a:call-1");
    expect(scoped.data).toMatchObject({
      toolCallId: "call-1",
      providerToolCallId: "call-1",
    });
  });

  it("only treats visible assistant text as renderable Kimi content", () => {
    expect(
      isRenderableKimiAssistantDelta({
        streamKind: "assistant_text",
        text: "done",
      }),
    ).toBe(true);
    expect(
      isRenderableKimiAssistantDelta({
        streamKind: "assistant_text",
        text: "   ",
      }),
    ).toBe(false);
    expect(
      isRenderableKimiAssistantDelta({
        streamKind: "reasoning_text",
        text: "thinking",
      }),
    ).toBe(false);
  });
});
