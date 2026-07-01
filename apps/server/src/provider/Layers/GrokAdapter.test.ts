// FILE: GrokAdapter.test.ts
// Purpose: Covers Grok-specific adapter guards that keep resumed ACP replay out of live turns.
// Layer: Provider adapter tests
// Depends on: GrokAdapter helper exports and shared contract ids.

import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  isGrokContextCompactionToolCall,
  isRenderableGrokAssistantDelta,
  mergeGrokModelDescriptors,
  parseXaiLanguageModelDescriptors,
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

  it("detects Grok compaction tool calls for context compaction UI rows", () => {
    expect(
      isGrokContextCompactionToolCall({
        toolCallId: "tool-1",
        kind: "other",
        status: "inProgress",
        title: "Compacting conversation context",
        data: {},
      }),
    ).toBe(true);
    expect(
      isGrokContextCompactionToolCall({
        toolCallId: "tool-2",
        kind: "execute",
        status: "completed",
        title: "Run tests",
        data: {},
      }),
    ).toBe(false);
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

  it("parses xAI language model API responses for picker discovery", () => {
    expect(
      parseXaiLanguageModelDescriptors({
        models: [
          {
            id: "grok-build-0.1",
            object: "model",
            aliases: ["grok-code-fast", "grok-code-fast-1", "grok-build-0.1", "ignored-alias"],
          },
          { id: "grok-code-fast-1-0825", object: "model" },
          { id: "grok-4.3", object: "model" },
          { id: "   " },
          null,
        ],
      }),
    ).toEqual([
      { slug: "grok-build-0.1", name: "Grok Build 0.1" },
      { slug: "grok-code-fast", name: "Grok Code Fast" },
      { slug: "grok-code-fast-1", name: "Grok Code Fast 1" },
      { slug: "grok-code-fast-1-0825", name: "Grok Code Fast 1 0825" },
    ]);
  });

  it("merges Grok CLI and xAI API model lists without duplicates", () => {
    expect(
      mergeGrokModelDescriptors([
        [
          { slug: "grok-build", name: "Grok 4.3" },
          { slug: "grok-build-0.1", name: "Grok Build 0.1" },
        ],
        [
          { slug: "grok-build-0.1", name: "Grok Build 0.1" },
          { slug: "grok-4.20-multi-agent", name: "Grok 4.20 Multi Agent" },
        ],
      ]),
    ).toEqual([
      { slug: "grok-build", name: "Grok 4.3" },
      { slug: "grok-build-0.1", name: "Grok Build 0.1" },
      { slug: "grok-4.20-multi-agent", name: "Grok 4.20 Multi Agent" },
    ]);
  });
});
