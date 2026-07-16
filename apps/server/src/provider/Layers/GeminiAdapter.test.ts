// FILE: GeminiAdapter.test.ts
// Purpose: Characterizes Gemini's private Synara host-policy delivery.
// Layer: Provider adapter tests

import { SYNARA_HARNESS_POLICY_MARKER } from "../../agentGateway/harnessPolicy.ts";
import { describe, expect, it } from "vitest";

import { takeGeminiSynaraHarnessPolicyTextPart } from "./GeminiAdapter.ts";

describe("Gemini Synara harness policy", () => {
  it("delivers scoped MCP host context exactly once per fresh/load/fork session", () => {
    for (const lifecycle of ["fresh", "load", "fork"] as const) {
      const state: { harnessPolicyDelivered?: boolean } = {};
      const first = takeGeminiSynaraHarnessPolicyTextPart(state, true);
      expect(first?.text, lifecycle).toContain(SYNARA_HARNESS_POLICY_MARKER);
      expect(first?.text, lifecycle).toContain("Use the synara_* tools");
      expect(takeGeminiSynaraHarnessPolicyTextPart(state, true), lifecycle).toBeNull();
    }
  });

  it("stays truthful without a scoped gateway connection", () => {
    expect(takeGeminiSynaraHarnessPolicyTextPart({}, false)?.text).toContain(
      "Synara MCP control is unavailable",
    );
  });
});
