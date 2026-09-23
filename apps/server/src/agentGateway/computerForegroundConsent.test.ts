import type { OrchestrationMessage } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ComputerApprovalGate } from "../computer/ComputerApprovalGate.ts";
import { makeComputerForegroundConsent } from "./computerForegroundConsent.ts";
import type { ToolContext } from "./toolRuntime.ts";

const context = (turnId: string | null = "turn-1"): ToolContext =>
  ({
    callerThreadId: "thread-1",
    callerTurnId: turnId,
    assertCallerTurnActive: () => Effect.void,
  }) as unknown as ToolContext;

const userMessage = (text: string): OrchestrationMessage =>
  ({ id: "m1", role: "user", source: "native", text }) as unknown as OrchestrationMessage;

function setup(
  messages: readonly OrchestrationMessage[] | undefined,
  answer: "accept" | "decline",
) {
  const gate = new ComputerApprovalGate();
  const cards: string[] = [];
  const loadMessages = vi.fn(async () => messages);
  const consent = makeComputerForegroundConsent({
    gate,
    loadMessages,
    knownAppNames: () => [],
    publish: () => async (requestId, decision) => {
      if (decision !== undefined) return;
      cards.push(requestId);
      gate.respond("thread-1", requestId, answer);
    },
  });
  return { consent, cards, loadMessages };
}

describe("makeComputerForegroundConsent", () => {
  it("authorizes from the user's own words without a card", async () => {
    const { consent, cards } = setup(
      [userMessage("Bring Dia to the front so I can watch.")],
      "decline",
    );
    expect(await consent.resolveForegroundAuthorization(context())).toEqual({
      userRequestedVisibleUse: true,
    });
    expect(cards).toEqual([]);
  });

  it("lets an approved card authorize the rest of the turn without rereading the thread", async () => {
    const { consent, cards, loadMessages } = setup(
      [userMessage("Open Dia and search my site")],
      "accept",
    );
    expect(await consent.resolveForegroundAuthorization(context())).toEqual({
      userRequestedVisibleUse: false,
    });
    const signal = new AbortController().signal;
    expect(
      await consent.requestForegroundConsent("computer_activate_window", {}, context(), signal),
    ).toBe(true);
    loadMessages.mockClear();
    expect(await consent.resolveForegroundAuthorization(context())).toEqual({
      userRequestedVisibleUse: true,
    });
    expect(loadMessages).not.toHaveBeenCalled();
    // A new turn starts over.
    expect(await consent.resolveForegroundAuthorization(context("turn-2"))).toEqual({
      userRequestedVisibleUse: false,
    });
    expect(cards).toHaveLength(1);
  });

  it("keeps a declined card declined and never asks without a turn", async () => {
    const { consent, cards } = setup([], "decline");
    const signal = new AbortController().signal;
    expect(
      await consent.requestForegroundConsent("computer_activate_window", {}, context(), signal),
    ).toBe(false);
    expect(await consent.resolveForegroundAuthorization(context())).toEqual({
      userRequestedVisibleUse: false,
    });
    expect(
      await consent.requestForegroundConsent("computer_activate_window", {}, context(null), signal),
    ).toBe(false);
    expect(cards).toHaveLength(1);
  });

  it("refuses when the thread is gone", async () => {
    const { consent } = setup(undefined, "accept");
    expect(await consent.resolveForegroundAuthorization(context())).toEqual({
      userRequestedVisibleUse: false,
    });
  });
});
