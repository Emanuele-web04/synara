import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  isRenderableDroidAssistantDelta,
  scopeDroidRuntimeItemIdForTurn,
  scopeDroidToolCallStateForTurn,
} from "./DroidAdapter.ts";

describe("DroidAdapter runtime event scoping", () => {
  it("makes reused ACP assistant segment ids unique per turn", () => {
    const providerItemId = "assistant:droid-session:segment:5";

    expect(scopeDroidRuntimeItemIdForTurn(TurnId.makeUnsafe("turn-a"), providerItemId)).toBe(
      "droid:turn-a:assistant:droid-session:segment:5",
    );
    expect(scopeDroidRuntimeItemIdForTurn(TurnId.makeUnsafe("turn-b"), providerItemId)).toBe(
      "droid:turn-b:assistant:droid-session:segment:5",
    );
  });

  it("preserves the provider tool id while scoping the runtime item id", () => {
    const scoped = scopeDroidToolCallStateForTurn(TurnId.makeUnsafe("turn-a"), {
      toolCallId: "call-1",
      kind: "execute",
      status: "completed",
      title: "Ran command",
      data: {
        toolCallId: "call-1",
      },
    });

    expect(scoped.toolCallId).toBe("droid:turn-a:call-1");
    expect(scoped.data).toMatchObject({
      toolCallId: "call-1",
      providerToolCallId: "call-1",
    });
  });

  it("only treats visible assistant text as renderable Droid content", () => {
    expect(
      isRenderableDroidAssistantDelta({
        streamKind: "assistant_text",
        text: "done",
      }),
    ).toBe(true);
    expect(
      isRenderableDroidAssistantDelta({
        streamKind: "assistant_text",
        text: "   ",
      }),
    ).toBe(false);
  });
});
