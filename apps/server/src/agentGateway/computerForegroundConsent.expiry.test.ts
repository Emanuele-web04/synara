import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ComputerApprovalExpiredError,
  ComputerApprovalGate,
} from "../computer/ComputerApprovalGate.ts";
import { makeComputerForegroundConsent } from "./computerForegroundConsent.ts";
import { ComputerProgressGuard } from "./computerProgressGuard.ts";
import { computerAuditErrorOutcome } from "./computerTools.ts";
import type { ToolContext } from "./toolRuntime.ts";

const context = {
  callerThreadId: "thread",
  callerTurnId: "turn",
  assertCallerTurnActive: () => Effect.void,
} as unknown as ToolContext;
const action = {
  scope: { threadId: "thread", turnId: "turn" },
  targetKey: "notion-window",
  actionKey: "foreground-type-text",
};

function fixture() {
  const gate = new ComputerApprovalGate();
  const cards: string[] = [];
  const consent = makeComputerForegroundConsent({
    gate,
    loadMessages: async () => [],
    knownAppNames: () => [],
    publish: () => async (id, decision) => {
      if (decision === undefined) cards.push(id);
    },
  });
  const request = () =>
    consent.requestForegroundConsent(
      "computer_type_text",
      { window_id: action.targetKey, delivery_mode: "foreground", text: "hello" },
      context,
      new AbortController().signal,
    );
  return { gate, consent, cards, request };
}

describe("foreground approval expiry at the tool boundary", () => {
  afterEach(() => vi.useRealTimers());

  it("propagates no-dispatch expiry to the tool boundary and audit without arming the retry guard", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { request, consent, cards, gate } = fixture();
    const guard = new ComputerProgressGuard();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const pending = request().catch((error: unknown) => error);
      // The gate's five-minute timeout starts after message/turn admission.
      await vi.waitFor(() => expect(cards).toHaveLength(attempt + 1));
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const error = await pending;
      expect(error).toBeInstanceOf(ComputerApprovalExpiredError);
      const failure = error as ComputerApprovalExpiredError;
      expect(failure).toMatchObject({
        code: "approval_expired",
        effect: "not-dispatched",
        retryable: true,
        message: expect.any(String),
      });
      const outcome = computerAuditErrorOutcome(failure);
      expect(outcome).toMatchObject({ effect: "not-dispatched", code: "approval_expired" });
      guard.record(action, outcome);
      expect(guard.check(action)).toBeUndefined();
      expect(await consent.resolveForegroundAuthorization(context)).toEqual({
        userRequestedVisibleUse: false,
      });
      expect(gate.respond("thread", cards[attempt]!, "accept")).toBe(false);
    }
    const next = request();
    await vi.waitFor(() => expect(cards).toHaveLength(5));
    gate.respond("thread", cards[4]!, "accept");
    await expect(next).resolves.toBe(true);
  });

  it("does not erase earlier uncertain input when a later approval expires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { request, cards } = fixture();
    const guard = new ComputerProgressGuard();
    guard.record(action, { effect: "dispatched-unknown" });
    guard.record(action, { effect: "dispatched-unknown" });
    const pending = request().catch((error: unknown) => error);
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    guard.record(action, computerAuditErrorOutcome(await pending));
    expect(guard.check(action)).toMatchObject({
      code: "repeated_unverified_action",
      previousInputMayHaveTakenEffect: true,
    });
  });

  it("keeps a deliberate decline binding without publishing another card", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { request, cards, gate } = fixture();
    const pending = request();
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    gate.respond("thread", cards[0]!, "decline");
    await expect(pending).resolves.toBe(false);
    await expect(request()).resolves.toBe(false);
    expect(cards).toHaveLength(1);
  });
});
