import { MessageId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { resolveTurnResumeTarget, type TurnResumeMessage } from "./turnResume";

const turnId = TurnId.makeUnsafe("turn-latest");
const user = (id: string, patch: Partial<TurnResumeMessage> = {}): TurnResumeMessage => ({
  id: MessageId.makeUnsafe(id),
  role: "user",
  turnId: null,
  ...patch,
});
const assistant = (id: string): TurnResumeMessage => ({
  id: MessageId.makeUnsafe(id),
  role: "assistant",
  turnId,
});

describe("resolveTurnResumeTarget", () => {
  it("resends a request that never started a turn", () => {
    expect(
      resolveTurnResumeTarget({
        messages: [user("first", { turnId }), assistant("reply"), user("unsent")],
        latestTurn: { turnId, state: "completed" },
      }),
    ).toEqual({ kind: "resend", messageId: MessageId.makeUnsafe("unsent") });
  });

  it.each(["interrupted", "error"] as const)(
    "continues a delivered request whose turn ended %s",
    (state) => {
      expect(
        resolveTurnResumeTarget({
          messages: [user("request", { turnId })],
          latestTurn: { turnId, state },
        }),
      ).toEqual({ kind: "continue", turnId, state });
    },
  );

  it("treats an answered request as delivered even without a turn link", () => {
    expect(
      resolveTurnResumeTarget({
        messages: [user("legacy"), assistant("reply")],
        latestTurn: { turnId, state: "interrupted" },
      }),
    ).toEqual({ kind: "continue", turnId, state: "interrupted" });
  });

  it("skips steers, which never start a turn of their own", () => {
    expect(
      resolveTurnResumeTarget({
        messages: [user("request", { turnId }), user("steer", { startsNewTurn: false })],
        latestTurn: { turnId, state: "interrupted" },
      }),
    ).toEqual({ kind: "continue", turnId, state: "interrupted" });
  });

  it.each([
    ["the latest turn completed", { turnId, state: "completed" as const }],
    ["a turn is still running", { turnId, state: "running" as const }],
    ["the thread never ran a turn", null],
  ])("offers nothing when %s and every request was delivered", (_case, latestTurn) => {
    expect(
      resolveTurnResumeTarget({ messages: [user("request", { turnId })], latestTurn }),
    ).toBeNull();
  });

  it("never resends while a turn is running", () => {
    expect(
      resolveTurnResumeTarget({
        messages: [user("queued")],
        latestTurn: { turnId, state: "running" },
      }),
    ).toBeNull();
  });
});
