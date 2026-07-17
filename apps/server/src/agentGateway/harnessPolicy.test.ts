import { assert, describe, it } from "@effect/vitest";

import {
  renderSynaraHarnessPolicy,
  SYNARA_HARNESS_POLICY_MARKER,
  takeSynaraHarnessPolicyForProviderSession,
  takeSynaraHarnessPolicyTextPartForProviderSession,
  takeSynaraHarnessPolicyForSession,
} from "./harnessPolicy.ts";

describe("Synara harness policy", () => {
  it("identifies Synara and explains exact batch coordination when MCP is available", () => {
    const policy = renderSynaraHarnessPolicy({ gatewayControlAvailable: true });
    assert.include(policy, SYNARA_HARNESS_POLICY_MARKER);
    assert.include(policy, "Synara is the host and harness");
    assert.include(policy, "synara_create_threads exactly once");
    assert.include(policy, "synara_wait_for_threads");
    assert.include(policy, "do not create Synara threads");
  });

  it("never advertises gateway mutation to providers without scoped MCP", () => {
    const policy = renderSynaraHarnessPolicy({ gatewayControlAvailable: false });
    assert.include(policy, "Synara MCP control is unavailable");
    assert.notInclude(policy, "call synara_create_threads exactly once");
  });

  it("delivers a private host-context block once per provider session", () => {
    const state: { harnessPolicyDelivered?: boolean } = {};
    assert.include(
      takeSynaraHarnessPolicyForSession(state, { gatewayControlAvailable: true }) ?? "",
      "<synara_host_context>",
    );
    assert.isNull(takeSynaraHarnessPolicyForSession(state, { gatewayControlAvailable: true }));
  });

  it("delivers once on fresh/load/fork sessions for every scoped MCP provider", () => {
    for (const provider of ["cursor", "grok", "droid"] as const) {
      for (const lifecycle of ["fresh", "load", "fork"] as const) {
        const state: { harnessPolicyDelivered?: boolean } = {};
        const first =
          takeSynaraHarnessPolicyTextPartForProviderSession(state, {
            provider,
            scopedGatewayConnectionAvailable: true,
          })?.text ?? "";
        assert.include(first, SYNARA_HARNESS_POLICY_MARKER, `${provider}/${lifecycle}`);
        assert.include(first, "Use the synara_* tools", `${provider}/${lifecycle}`);
        assert.isNull(
          takeSynaraHarnessPolicyForProviderSession(state, {
            provider,
            scopedGatewayConnectionAvailable: true,
          }),
          `${provider}/${lifecycle}`,
        );
      }
    }
  });

  it("keeps OpenCode, Kilo, and Pi identity-only even if a transport flag is wrong", () => {
    for (const provider of ["opencode", "kilo", "pi"] as const) {
      const text =
        takeSynaraHarnessPolicyForProviderSession(
          {},
          { provider, scopedGatewayConnectionAvailable: true },
        ) ?? "";
      assert.include(text, SYNARA_HARNESS_POLICY_MARKER, provider);
      assert.include(text, "Synara MCP control is unavailable", provider);
      assert.notInclude(text, "call synara_create_threads exactly once", provider);
    }
  });
});
