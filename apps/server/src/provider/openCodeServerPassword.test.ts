import { describe, expect, it } from "vitest";

import { canUseDefaultOpenCodeServerPassword } from "./openCodeServerPassword";

describe("OpenCode default server password routing", () => {
  it("allows only the canonical default instance to resolve the provider-wide secret", () => {
    expect(canUseDefaultOpenCodeServerPassword("opencode", undefined)).toBe(true);
    expect(canUseDefaultOpenCodeServerPassword("opencode", "opencode")).toBe(true);
    expect(canUseDefaultOpenCodeServerPassword("opencode", "opencode_work")).toBe(false);
    expect(canUseDefaultOpenCodeServerPassword("opencode", "work")).toBe(false);
  });
});
