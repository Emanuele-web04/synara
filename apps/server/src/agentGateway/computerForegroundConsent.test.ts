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

  it("lets an approved card authorize the rest of the turn while checking for newer instructions", async () => {
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
    expect(loadMessages).toHaveBeenCalledOnce();
    // A new turn starts over.
    expect(await consent.resolveForegroundAuthorization(context("turn-2"))).toEqual({
      userRequestedVisibleUse: false,
    });
    expect(cards).toHaveLength(1);
  });

  it("revokes a card grant when later input asks to stay in the background", async () => {
    const messages: OrchestrationMessage[] = [userMessage("Open Dia and search my site")];
    const { consent, cards } = setup(messages, "accept");
    const signal = new AbortController().signal;
    expect(
      await consent.requestForegroundConsent("computer_activate_window", {}, context(), signal),
    ).toBe(true);
    messages.push({
      ...userMessage("Keep the browser in the background"),
      id: "m2" as OrchestrationMessage["id"],
      source: "async-user-input",
    });
    expect(await consent.resolveForegroundAuthorization(context())).toEqual({
      userRequestedVisibleUse: false,
    });
    expect(
      await consent.requestForegroundConsent("computer_activate_window", {}, context(), signal),
    ).toBe(false);
    expect(cards).toHaveLength(1);
  });

  it("does not use an approval if task instructions change while the card is open", async () => {
    const gate = new ComputerApprovalGate();
    const messages: OrchestrationMessage[] = [userMessage("Open Dia")];
    const consent = makeComputerForegroundConsent({
      gate,
      loadMessages: async () => messages,
      knownAppNames: () => [],
      publish: () => async (requestId, decision) => {
        if (decision !== undefined) return;
        messages.push({
          ...userMessage("Keep this in the background"),
          id: "m2" as OrchestrationMessage["id"],
          source: "async-user-input",
        });
        gate.respond("thread-1", requestId, "accept");
      },
    });
    expect(
      await consent.requestForegroundConsent(
        "computer_activate_window",
        {},
        context(),
        new AbortController().signal,
      ),
    ).toBe(false);
    expect(await consent.resolveForegroundAuthorization(context())).toEqual({
      userRequestedVisibleUse: false,
    });
  });

  it("honors a card after pre-existing agent-origin user rows", async () => {
    const agentMessage = {
      ...userMessage("Inspect the app"),
      dispatchOrigin: "agent",
    } as OrchestrationMessage;
    const { consent } = setup([agentMessage], "accept");
    expect(
      await consent.requestForegroundConsent(
        "computer_activate_window",
        {},
        context(),
        new AbortController().signal,
      ),
    ).toBe(true);
    expect(await consent.resolveForegroundAuthorization(context())).toEqual({
      userRequestedVisibleUse: true,
    });
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
