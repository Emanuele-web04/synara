import { describe, expect, it } from "vitest";

import {
  ComputerProgressGuard,
  type ComputerProgressAction,
  type ComputerProgressOutcome,
} from "./computerProgressGuard.ts";

const action = (actionKey: string, targetKey = "window-1:field-1"): ComputerProgressAction => ({
  scope: { threadId: "thread-1", turnId: "turn-1", sessionKey: "session-1" },
  targetKey,
  actionKey,
});
const uncertain: ComputerProgressOutcome = { effect: "dispatched-unknown" };
const refusal: ComputerProgressOutcome = {
  effect: "not-dispatched",
  code: "same_pid_keyboard_ambiguity",
};

describe("ComputerProgressGuard", () => {
  it("blocks a third identical uncertain mutation before it can be sent", () => {
    const guard = new ComputerProgressGuard();
    const enter = action("press-key:enter");
    expect(guard.check(enter)).toBeUndefined();
    guard.record(enter, uncertain);
    expect(guard.check(enter)).toBeUndefined();
    guard.record(enter, uncertain);
    expect(guard.check(enter)).toMatchObject({
      code: "repeated_unverified_action",
      effect: "not-dispatched",
      retryable: false,
      previousInputMayHaveTakenEffect: true,
    });
  });

  it("blocks alternating clicks and keys after three same-reason target refusals", () => {
    const guard = new ComputerProgressGuard();
    const click = action("click");
    const enter = action("press-key:enter");
    guard.record(click, refusal);
    guard.record(enter, refusal);
    expect(guard.check(click)).toBeUndefined();
    guard.record(click, refusal);
    for (const next of [click, enter]) {
      expect(guard.check(next)).toMatchObject({
        code: "repeated_computer_refusal",
        previousInputMayHaveTakenEffect: false,
        retryable: false,
      });
    }
    expect(guard.check(action("select-text:exact-field"))).toBeUndefined();
    expect(guard.check(action("click", "window-1:corrected-field"))).toBeUndefined();
  });

  it("counts persistent server target refusals as well as native pre-dispatch refusals", () => {
    const guard = new ComputerProgressGuard();
    const click = action("click");
    for (let index = 0; index < 3; index += 1) {
      guard.record(click, { effect: "refused", code: "computer_target_ambiguous" });
    }
    expect(guard.check(click)?.code).toBe("repeated_computer_refusal");
  });

  it.each([
    "computer_controlled_by_other_thread",
    "computer_busy",
    "native_input_busy",
    "computer_input_paused",
    "desktop_input_paused",
    "input_admission_closed",
    "input_monitor_unavailable",
    "computer_control_revoked",
    "computer_stopped",
    "computer_permission_required",
    "computer_setup_required",
    "browser_requires_setup",
    "approval_denied",
    "approval_unavailable",
    "approval_queue_full",
    "target_not_on_active_space",
    "auth_sheet_focused",
  ])("permits admission recovery after repeated %s refusals", (code) => {
    const guard = new ComputerProgressGuard();
    const enter = action("press-key:enter");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      guard.record(enter, { effect: attempt % 2 === 0 ? "refused" : "not-dispatched", code });
      expect(guard.check(enter)).toBeUndefined();
    }
    // The native boundary can now admit the action, with no invented desktop
    // verification required just to recover from a lease or setup refusal.
    guard.record(enter, uncertain);
    expect(guard.check(enter)).toBeUndefined();
  });

  it("does not erase uncertainty or trust a transient-looking code after dispatch", () => {
    const guard = new ComputerProgressGuard();
    const enter = action("press-key:enter");
    guard.record(enter, uncertain);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      guard.record(enter, { effect: "refused", code: "computer_input_paused" });
    }
    guard.record(enter, { effect: "dispatched-unknown", code: "computer_input_paused" });
    expect(guard.check(enter)?.code).toBe("repeated_unverified_action");
  });

  it("does not conflate distinct refusal reasons or unrelated targets", () => {
    const guard = new ComputerProgressGuard();
    const enter = action("press-key:enter");
    guard.record(enter, refusal);
    guard.record(enter, { effect: "refused", code: "stale_target" });
    guard.record(action("press-key:enter", "window-2:field-1"), refusal);
    expect(guard.check(enter)).toBeUndefined();
  });

  it.each([
    ["click", "press-key:enter"],
    ["click", "press-key:enter", "press-key:tab"],
    ["click", "press-key:enter", "press-key:tab", "type-text"],
  ])("detects a repeated uncertain cycle beginning with %s", (...cycle: string[]) => {
    const guard = new ComputerProgressGuard();
    for (let repetition = 0; repetition < 3; repetition += 1) {
      for (const key of cycle) {
        const next = action(key);
        expect(guard.check(next)).toBeUndefined();
        guard.record(next, uncertain);
      }
    }
    expect(guard.check(action(cycle[0]!))?.code).toBe("repeated_unverified_action");
    expect(guard.check(action("different-semantic-approach"))).toBeUndefined();
  });

  it("allows a normal calculator sequence and long sequences of different actions", () => {
    const guard = new ComputerProgressGuard();
    for (const key of ["clear", "1", "2", "3", "multiply", "4", "5", "equals"]) {
      const next = action(`calculator:${key}`);
      expect(guard.check(next)).toBeUndefined();
      guard.record(next, uncertain);
    }
    for (let index = 0; index < 100; index += 1) {
      const next = action(`different-control:${index}`);
      expect(guard.check(next)).toBeUndefined();
      guard.record(next, uncertain);
    }
  });

  it("does not let reads, no-ops, or intervening refusals erase earlier uncertainty", () => {
    const guard = new ComputerProgressGuard();
    const enter = action("press-key:enter");
    guard.record(enter, uncertain);
    // Observation handlers call neither record nor recordVerifiedProgress.
    // Checking a call is read-only, so a fresh screenshot cannot reset history.
    expect(guard.check(action("observation:screenshot-2"))).toBeUndefined();
    guard.record(action("click"), { effect: "not-dispatched" });
    guard.record(action("click"), refusal);
    guard.record(enter, uncertain);
    expect(guard.check(enter)?.code).toBe("repeated_unverified_action");
  });

  it("treats errors without dispatch proof as potentially delivered input", () => {
    const guard = new ComputerProgressGuard();
    const enter = action("press-key:enter");
    guard.record(enter, { effect: "error", code: "computer_backend_error" });
    guard.record(enter, uncertain);
    expect(guard.check(enter)?.previousInputMayHaveTakenEffect).toBe(true);
  });

  it("only a verified effect clears both refusal and uncertain history for that target", () => {
    const guard = new ComputerProgressGuard();
    const enter = action("press-key:enter");
    guard.record(enter, uncertain);
    guard.record(enter, uncertain);
    for (let index = 0; index < 3; index += 1) guard.record(enter, refusal);
    expect(guard.check(enter)).toBeDefined();
    guard.record(action("verified-correction"), { effect: "verified" });
    expect(guard.check(enter)).toBeUndefined();
    guard.record(enter, uncertain);
    expect(guard.check(enter)).toBeUndefined();
  });

  it("explicit verification clears its target without clearing unrelated uncertainty", () => {
    const guard = new ComputerProgressGuard();
    const first = action("press-key:enter");
    const second = action("click", "window-2:field-1");
    for (const next of [first, second]) {
      guard.record(next, uncertain);
      guard.record(next, uncertain);
    }
    guard.recordVerifiedProgress(first.scope, first.targetKey);
    expect(guard.check(first)).toBeUndefined();
    expect(guard.check(second)?.code).toBe("repeated_unverified_action");
  });

  it("isolates new turns, threads, and provider sessions", () => {
    const guard = new ComputerProgressGuard();
    const enter = action("press-key:enter");
    guard.record(enter, uncertain);
    guard.record(enter, uncertain);
    for (const scope of [
      { ...enter.scope, turnId: "turn-2" },
      { ...enter.scope, threadId: "thread-2" },
      { ...enter.scope, sessionKey: "session-2" },
    ]) {
      expect(guard.check({ ...enter, scope })).toBeUndefined();
    }
    expect(guard.check(enter)).toBeDefined();
  });

  it("keeps unknown-effect warnings even when repeated refusals trigger the block", () => {
    const guard = new ComputerProgressGuard();
    const enter = action("press-key:enter");
    guard.record(action("earlier-click"), uncertain);
    for (let index = 0; index < 3; index += 1) guard.record(enter, refusal);
    const blocked = guard.check(enter);
    expect(blocked?.code).toBe("repeated_computer_refusal");
    expect(blocked?.previousInputMayHaveTakenEffect).toBe(true);
    expect(blocked?.message).toContain("do not replay it or switch to foreground");
    expect(blocked?.message).toContain("A fresh screenshot alone does not establish progress");
  });

  it("evicts old scopes and targets while preserving recently active histories", () => {
    const guard = new ComputerProgressGuard(2, 2);
    const first = action("click", "target-1");
    const second = action("click", "target-2");
    const third = action("click", "target-3");
    for (const next of [first, second, first, third, third]) guard.record(next, uncertain);
    expect(guard.check(first)).toBeDefined();
    expect(guard.check(second)).toBeUndefined();
    expect(guard.check(third)).toBeDefined();

    const otherScope = { ...first, scope: { ...first.scope, turnId: "turn-2" } };
    guard.record(otherScope, uncertain);
    guard.record(first, uncertain);
    guard.record({ ...first, scope: { ...first.scope, turnId: "turn-3" } }, uncertain);
    expect(guard.check(first)).toBeDefined();
    expect(guard.check(otherScope)).toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid retention limits %s",
    (limit) => {
      expect(() => new ComputerProgressGuard(limit)).toThrow(TypeError);
      expect(() => new ComputerProgressGuard(1, limit)).toThrow(TypeError);
    },
  );
});
