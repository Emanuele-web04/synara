// FILE: automationFailurePolicy.test.ts
// Purpose: Locks down the failure-policy vocabulary shared by the dialog and detail page.
// Layer: Web lib test
// Depends on: automationFailurePolicy converters and option builder.

import { describe, expect, it } from "vitest";

import {
  AUTOMATION_FAILURE_POLICY_NEVER,
  automationFailurePolicyOptions,
  automationFailurePolicyValue,
  stopAfterConsecutiveFailuresFromPolicyValue,
} from "./automationFailurePolicy";

describe("automation failure policy values", () => {
  it("maps a stored threshold to its UI value and back", () => {
    expect(automationFailurePolicyValue(null)).toBe(AUTOMATION_FAILURE_POLICY_NEVER);
    expect(automationFailurePolicyValue(1)).toBe("1");
    expect(automationFailurePolicyValue(7)).toBe("7");

    expect(stopAfterConsecutiveFailuresFromPolicyValue(AUTOMATION_FAILURE_POLICY_NEVER)).toBeNull();
    expect(stopAfterConsecutiveFailuresFromPolicyValue("1")).toBe(1);
    expect(stopAfterConsecutiveFailuresFromPolicyValue("7")).toBe(7);
  });

  it("falls back to the default threshold for unparseable UI values", () => {
    expect(stopAfterConsecutiveFailuresFromPolicyValue("")).toBe(3);
    expect(stopAfterConsecutiveFailuresFromPolicyValue("abc")).toBe(3);
    expect(stopAfterConsecutiveFailuresFromPolicyValue("0")).toBe(3);
    expect(stopAfterConsecutiveFailuresFromPolicyValue("-2")).toBe(3);
  });
});

describe("automationFailurePolicyOptions", () => {
  it("does not prepend when the current value is a preset or never", () => {
    expect(automationFailurePolicyOptions("never").map((option) => option.value)).toEqual([
      "1",
      "3",
      "5",
      "never",
    ]);
  });

  it("prepends a non-preset stored threshold so it renders as itself", () => {
    expect(automationFailurePolicyOptions("7")).toEqual([
      { value: "7", label: "Stop after 7 failures" },
      { value: "1", label: "Stop after 1 failure" },
      { value: "3", label: "Stop after 3 failures" },
      { value: "5", label: "Stop after 5 failures" },
      { value: "never", label: "Keep running" },
    ]);
  });
});
