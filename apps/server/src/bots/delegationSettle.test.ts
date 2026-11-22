import { describe, expect, it } from "vitest";

import {
  evaluateDelegationSettlement,
  type SettleItem,
  type SettleOnward,
  type SettleTurn,
} from "./delegationSettle";

const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

const turn = (overrides: Partial<SettleTurn>): SettleTurn => ({
  turnId: "t1",
  pendingMessageId: "synbot:delegation:d1",
  state: "completed",
  requestedAt: at(600),
  completedAt: at(500),
  assistantMessageId: "a1",
  ...overrides,
});
const item = (overrides: Partial<SettleItem>): SettleItem => ({
  id: "w1",
  state: "completed",
  delegationTurnId: "t1",
  updatedAt: at(400),
  ...overrides,
});
const evaluate = (turns: SettleTurn[], items: SettleItem[] = [], active: string | null = null) =>
  evaluateDelegationSettlement({
    messageId: "synbot:delegation:d1",
    turns,
    attributableMessageIds: new Set(["wake-1"]),
    items,
    sessionActiveTurnId: active,
    nowMs: NOW,
  });

const onward = (overrides: Partial<SettleOnward>): SettleOnward => ({
  fromTurnId: "t1",
  reportMessageId: null,
  reportedAt: null,
  ...overrides,
});

describe("evaluateDelegationSettlement", () => {
  it("is sent until the target turn exists, working while it runs", () => {
    expect(evaluate([]).state).toBe("sent");
    expect(evaluate([turn({ state: "running", completedAt: null })]).state).toBe("working");
    expect(evaluate([turn({})], [], "t1").state).toBe("working");
  });

  it("settles a direct answer at once and keeps its reply", () => {
    expect(evaluate([turn({})])).toMatchObject({
      state: "settled",
      outcome: "completed",
      lastAssistantMessageId: "a1",
    });
  });

  it("follows the tasks the turn started, waits for the user, then for the wake", () => {
    expect(evaluate([turn({})], [item({ state: "working" })]).state).toBe("working");
    expect(evaluate([turn({})], [item({ state: "waiting" })]).state).toBe("waiting");
    expect(evaluate([turn({})], [item({ updatedAt: at(5) })]).state).toBe("working");
    expect(evaluate([turn({})], [item({})])).toMatchObject({
      state: "settled",
      outcome: "completed",
      itemIds: ["w1"],
    });
  });

  it("counts the Hub's wake turns and their tasks as part of the delegation", () => {
    const wake = turn({
      turnId: "t2",
      pendingMessageId: "wake-1",
      requestedAt: at(300),
      completedAt: at(200),
      assistantMessageId: "a2",
    });
    const result = evaluate(
      [turn({}), wake],
      [item({}), item({ id: "w2", delegationTurnId: "t2", updatedAt: at(100) })],
    );
    expect(result).toMatchObject({ state: "settled", lastAssistantMessageId: "a2" });
    expect(result.itemIds).toEqual(["w1", "w2"]);
    const unrelated = turn({ turnId: "t0", pendingMessageId: "wake-1", requestedAt: at(900) });
    expect(evaluate([unrelated, turn({})]).turnIds).toEqual(["t1"]);
  });

  it("fails when every task failed or the only turn errored", () => {
    expect(evaluate([turn({})], [item({ state: "failed" })]).outcome).toBe("failed");
    expect(evaluate([turn({ state: "error", assistantMessageId: null })]).outcome).toBe("failed");
    expect(evaluate([turn({})], [item({ state: "failed" }), item({ id: "w2" })]).outcome).toBe(
      "completed",
    );
  });

  describe("work handed on", () => {
    const evaluateChain = (turns: SettleTurn[], children: SettleOnward[]) =>
      evaluateDelegationSettlement({
        messageId: "synbot:delegation:d1",
        turns,
        attributableMessageIds: new Set(),
        items: [],
        onward: children,
        sessionActiveTurnId: null,
        nowMs: NOW,
      });
    const reportWake = turn({
      turnId: "t2",
      pendingMessageId: "synbot:report:r1",
      requestedAt: at(200),
      completedAt: at(100),
      assistantMessageId: "a2",
    });

    it("stays working while a hand-off from the delegated turn is not reported", () => {
      expect(evaluateChain([turn({})], [onward({})]).state).toBe("working");
      // A hand-off from another turn of the target's is not this delegation's work.
      expect(evaluateChain([turn({})], [onward({ fromTurnId: "t-other" })]).state).toBe("settled");
    });

    it("waits for the turn the report wakes, then settles with its answer", () => {
      const reported = onward({ reportMessageId: "synbot:report:r1", reportedAt: at(250) });
      // Reported a moment ago, and the wake has not started yet.
      expect(evaluateChain([turn({})], [{ ...reported, reportedAt: at(30) }]).state).toBe(
        "working",
      );
      // The wake runs: still working, and it counts as the delegation's turn.
      const running = evaluateChain(
        [
          turn({}),
          { ...reportWake, state: "running", completedAt: null, assistantMessageId: null },
        ],
        [reported],
      );
      expect(running.state).toBe("working");
      expect(running.turnIds).toEqual(["t1", "t2"]);
      // The wake answered: the delegation settles with that answer.
      const settled = evaluateChain([turn({}), reportWake], [reported]);
      expect(settled.state).toBe("settled");
      expect(settled.outcome).toBe("completed");
      expect(settled.lastAssistantMessageId).toBe("a2");
    });

    it("follows a wake that hands work on again", () => {
      const first = onward({ reportMessageId: "synbot:report:r1", reportedAt: at(250) });
      const second = onward({ fromTurnId: "t2" });
      expect(evaluateChain([turn({}), reportWake], [first, second]).state).toBe("working");
    });

    it("stops holding on for a stopped hand-off or a report that never woke anyone", () => {
      // Stopped by the user: closed without a report message.
      expect(evaluateChain([turn({})], [onward({ reportedAt: at(250) })]).state).toBe("settled");
      // Reported long ago, and no wake ever showed up.
      expect(
        evaluateChain(
          [turn({})],
          [onward({ reportMessageId: "synbot:report:r1", reportedAt: at(300) })],
        ).state,
      ).toBe("settled");
    });

    it("keeps waiting while another active turn delays an onward report", () => {
      const result = evaluateDelegationSettlement({
        messageId: "synbot:delegation:d1",
        turns: [turn({})],
        attributableMessageIds: new Set(),
        items: [],
        onward: [onward({ reportMessageId: "synbot:report:r1", reportedAt: at(300) })],
        sessionActiveTurnId: "unrelated-turn",
        nowMs: NOW,
        graceMs: 60_000,
      });
      expect(result.state).toBe("working");
    });

    it("fails when the onward report wake turn errors instead of returning stale turn 1", () => {
      const failedWake = turn({
        turnId: "t2",
        pendingMessageId: "synbot:report:r1",
        state: "error",
        requestedAt: at(240),
        completedAt: at(230),
        assistantMessageId: null,
      });
      const reported = onward({ reportMessageId: "synbot:report:r1", reportedAt: at(250) });
      const result = evaluateChain([turn({}), failedWake], [reported]);
      expect(result.state).toBe("settled");
      expect(result.outcome).toBe("failed");
    });

    it("settles immediately once a rollup wake turn completes after finished tasks", () => {
      const task = {
        id: "w1",
        state: "completed" as const,
        delegationTurnId: "t1",
        updatedAt: at(10),
      };
      const wake = turn({
        turnId: "t2",
        pendingMessageId: "hub-wake-1",
        requestedAt: at(9),
        completedAt: at(5),
        assistantMessageId: "a2",
      });
      const result = evaluateDelegationSettlement({
        messageId: "synbot:delegation:d1",
        turns: [turn({}), wake],
        attributableMessageIds: new Set(["hub-wake-1"]),
        items: [task],
        sessionActiveTurnId: null,
        nowMs: NOW,
        graceMs: 60_000,
      });
      expect(result.state).toBe("settled");
      expect(result.outcome).toBe("completed");
      expect(result.lastAssistantMessageId).toBe("a2");
    });
  });
});
