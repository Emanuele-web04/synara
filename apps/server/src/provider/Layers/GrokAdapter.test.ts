// FILE: GrokAdapter.test.ts
// Purpose: Covers Grok-specific adapter guards that keep resumed ACP replay out of live turns.
// Layer: Provider adapter tests
// Depends on: GrokAdapter helper exports and shared contract ids.

import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  isRenderableGrokAssistantDelta,
  scopeGrokRuntimeItemIdForTurn,
  scopeGrokToolCallStateForTurn,
} from "./GrokAdapter.ts";

describe("GrokAdapter runtime event scoping", () => {
  it("makes reused ACP assistant segment ids unique per DP turn", () => {
    const providerItemId = "assistant:grok-session:segment:5";

    expect(scopeGrokRuntimeItemIdForTurn(TurnId.makeUnsafe("turn-a"), providerItemId)).toBe(
      "grok:turn-a:assistant:grok-session:segment:5",
    );
    expect(scopeGrokRuntimeItemIdForTurn(TurnId.makeUnsafe("turn-b"), providerItemId)).toBe(
      "grok:turn-b:assistant:grok-session:segment:5",
    );
  });

  it("preserves the provider tool id while scoping the runtime item id", () => {
    const scoped = scopeGrokToolCallStateForTurn(TurnId.makeUnsafe("turn-a"), {
      toolCallId: "call-1",
      kind: "execute",
      status: "completed",
      title: "Ran command",
      data: {
        toolCallId: "call-1",
      },
    });

    expect(scoped.toolCallId).toBe("grok:turn-a:call-1");
    expect(scoped.data).toMatchObject({
      toolCallId: "call-1",
      providerToolCallId: "call-1",
    });
  });

  it("only treats visible assistant text as renderable Grok content", () => {
    expect(
      isRenderableGrokAssistantDelta({
        streamKind: "assistant_text",
        text: "done",
      }),
    ).toBe(true);
    expect(
      isRenderableGrokAssistantDelta({
        streamKind: "assistant_text",
        text: "   ",
      }),
    ).toBe(false);
    expect(
      isRenderableGrokAssistantDelta({
        streamKind: "reasoning_text",
        text: "thinking",
      }),
    ).toBe(false);
  });
});
