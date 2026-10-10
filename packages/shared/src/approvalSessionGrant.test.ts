import { describe, expect, it } from "vitest";

import { approvalSessionGrantWidensSessionPolicy } from "./approvalSessionGrant";

describe("approvalSessionGrantWidensSessionPolicy", () => {
  it("widens the session only for command and file prompts", () => {
    expect(approvalSessionGrantWidensSessionPolicy("command")).toBe(true);
    expect(approvalSessionGrantWidensSessionPolicy("file-read")).toBe(true);
    expect(approvalSessionGrantWidensSessionPolicy("file-change")).toBe(true);
    expect(approvalSessionGrantWidensSessionPolicy(undefined)).toBe(true);
  });

  it("keeps tool and permission-profile grants scoped to what was asked", () => {
    expect(approvalSessionGrantWidensSessionPolicy("tool")).toBe(false);
    expect(approvalSessionGrantWidensSessionPolicy("permissions")).toBe(false);
  });
});
