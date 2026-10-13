import { expect, it } from "vitest";
import { evaluateAgentProfileTrust } from "./agentProfileTrust.ts";
it("does not treat self-asserted vendor or legacy provenance as a credential grant", () => {
  expect(
    evaluateAgentProfileTrust({
      provenance: { source: "legacy-settings-acp" },
      trust: { brands: ["openai"], organizations: ["synara"], workflows: ["harnessed"] },
    }),
  ).toBe(false);
  expect(evaluateAgentProfileTrust({ trust: { allowCredentialAccess: true } })).toBe(true);
  expect(
    evaluateAgentProfileTrust({
      trust: { allowCredentialAccess: true, brands: ["distrust:vendor"] },
    }),
  ).toBe(false);
});
