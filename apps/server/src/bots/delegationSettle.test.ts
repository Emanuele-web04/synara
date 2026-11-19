import { describe, expect, it } from "vitest";

import { evaluateDelegationSettlement, type SettleItem, type SettleTurn } from "./delegationSettle";

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
});
