import { describe, expect, it } from "vitest";

import { ComputerProgressGuard } from "./computerProgressGuard.ts";

const action = {
  scope: { threadId: "thread", turnId: "turn" },
  targetKey: "notion-window",
  actionKey: "foreground-type-text",
};

describe("approval expiry and the computer progress guard", () => {
  it("does not treat an expired card as a repeated dispatch or target refusal", () => {
    const guard = new ComputerProgressGuard();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      guard.record(action, { effect: "not-dispatched", code: "approval_expired" });
      expect(guard.check(action)).toBe(undefined);
    }
  });

  it("preserves earlier uncertain delivery across an approval timeout", () => {
    const guard = new ComputerProgressGuard();
    guard.record(action, { effect: "dispatched-unknown" });
    guard.record(action, { effect: "dispatched-unknown" });
    guard.record(action, { effect: "not-dispatched", code: "approval_expired" });
    expect(guard.check(action)).toMatchObject({
      code: "repeated_unverified_action",
      previousInputMayHaveTakenEffect: true,
    });
  });

  it("never lets a timeout code relabel an uncertain effect as undispatched", () => {
    const guard = new ComputerProgressGuard();
    guard.record(action, { effect: "dispatched-unknown", code: "approval_expired" });
    guard.record(action, { effect: "dispatched-unknown", code: "approval_expired" });
    expect(guard.check(action)).toMatchObject({ code: "repeated_unverified_action" });
  });
});
