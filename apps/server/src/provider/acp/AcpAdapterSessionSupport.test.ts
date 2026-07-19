import { ThreadId, TurnId, type ProviderSession } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  clearAcpActiveTurn,
  finalizeAcpActiveTurnCost,
  recordAcpSessionCost,
  resolveAcpSessionCwd,
  scopeAcpRuntimeItemIdForTurn,
  scopeAcpToolCallStateForTurn,
  withAcpPlanModePrompt,
} from "./AcpAdapterSessionSupport.ts";

describe("ACP adapter session support", () => {
  it("scopes reused runtime and tool ids while preserving the provider id", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    expect(scopeAcpRuntimeItemIdForTurn("grok", turnId, "item-1")).toBe("grok:turn-1:item-1");
    expect(
      scopeAcpToolCallStateForTurn("grok", turnId, {
        toolCallId: "call-1",
        status: "completed",
        data: { toolCallId: "call-1" },
      }),
    ).toMatchObject({
      toolCallId: "grok:turn-1:call-1",
      data: { toolCallId: "call-1", providerToolCallId: "call-1" },
    });
  });

  it("clears only the matching active turn and removes it from the session snapshot", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const context = {
      activeTurnId: turnId as TurnId | undefined,
      activeTurnHadAssistantContent: true,
      activeAssistantItemsWithContent: new Set(["item-1"]),
      activeTurnFailedToolDetail: "failed" as string | undefined,
      activePromptFiber: { id: "fiber" } as { id: string } | undefined,
      activeInteractionMode: "plan" as "plan" | "default" | undefined,
      session: {
        provider: "grok",
        status: "running",
        threadId: ThreadId.makeUnsafe("thread-1"),
        activeTurnId: turnId,
        createdAt: "2026-07-19T00:00:00.000Z",
        updatedAt: "2026-07-19T00:00:00.000Z",
      } satisfies ProviderSession,
    };

    expect(clearAcpActiveTurn(context, TurnId.makeUnsafe("other-turn"))).toBe(false);
    expect(clearAcpActiveTurn(context, turnId)).toBe(true);
    expect(context).toMatchObject({
      activeTurnId: undefined,
      activeTurnHadAssistantContent: false,
      activeTurnFailedToolDetail: undefined,
      activePromptFiber: undefined,
      activeInteractionMode: undefined,
    });
    expect(context.activeAssistantItemsWithContent.size).toBe(0);
    expect(Object.hasOwn(context.session, "activeTurnId")).toBe(false);
  });

  it("records only valid USD cost snapshots", () => {
    const context = { latestSessionCostUsd: undefined as number | undefined };
    recordAcpSessionCost(context, { amount: 1.25, currency: "USD" });
    expect(finalizeAcpActiveTurnCost(context)).toEqual({ cumulativeCostUsd: 1.25 });
    recordAcpSessionCost(context, { amount: 99, currency: "EUR" });
    expect(finalizeAcpActiveTurnCost(context)).toEqual({ cumulativeCostUsd: 1.25 });
  });

  it("wraps only Plan-mode prompts", () => {
    expect(
      withAcpPlanModePrompt({
        text: "  inspect this  ",
        interactionMode: "plan",
        promptPrefix: "PLAN",
      }),
    ).toBe("PLAN\n\nUser request:\ninspect this");
    expect(
      withAcpPlanModePrompt({
        text: "  preserve spacing  ",
        interactionMode: "default",
        promptPrefix: "PLAN",
      }),
    ).toBe("  preserve spacing  ");
  });

  it("resolves explicit, session, and server fallback working directories in order", () => {
    expect(
      resolveAcpSessionCwd({
        inputCwd: "/explicit",
        sessionCwd: "/session",
        serverCwd: "/server",
        homeDir: "/home/test",
      }),
    ).toBe("/explicit");
    expect(
      resolveAcpSessionCwd({
        inputCwd: undefined,
        sessionCwd: "/session",
        serverCwd: "/server",
        homeDir: "/home/test",
      }),
    ).toBe("/session");
    expect(
      resolveAcpSessionCwd({
        inputCwd: undefined,
        serverCwd: "/server",
        homeDir: "/home/test",
      }),
    ).toBe("/server");
  });
});
