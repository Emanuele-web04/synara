// FILE: agentProfileTrust.ts
// Purpose: Pure, deterministic provenance-based trust evaluation shared by the
// profile lifecycle service and the session-launch gate. Kept dependency-free
// so both services can import the same verdict without a cycle.
// Layer: Server external agents
// Exports: evaluateAgentProfileTrust, profileEvidenceNamespace

import type { AgentProfileRevision, AgentProfileTrust } from "@synara/contracts";

const KNOWN_GOOD_WORKFLOWS = new Set(["code-review", "plan", "harnessed"]);
const KNOWN_GOOD_BRANDS = new Set(["openai", "anthropic", "synara"]);
const KNOWN_GOOD_ORGANIZATIONS = new Set(["synara"]);

/**
 * Capability-evidence namespace for a profile. Evidence rows are keyed by this
 * namespace; the conformance runner and evidence service both write to it.
 */
export const profileEvidenceNamespace = (profileId: string): string =>
  `external:agentprofile:${profileId}`;

/**
 * Deterministic trust verdict for a profile revision. A profile is trusted for
 * credential release when it shipped with a known-good workflow, OR an explicit
 * vendor-brand/org claim was verified. Explicitly distrust claims
 * (`distrust:*`) win over everything and force untrusted.
 */
export function evaluateAgentProfileTrust(input: {
  readonly provenance?: { readonly source?: string; readonly version?: string | undefined };
  readonly trust?: AgentProfileTrust | undefined;
}): boolean {
  const source = input.provenance?.source ?? "";
  const claims = input.trust ?? {};
  const workflows = claims.workflows ?? [];
  const brands = claims.brands ?? [];
  const organizations = claims.organizations ?? [];

  // Explicit distrust wins before the additive default.
  if ([...workflows, ...brands, ...organizations].some((claim) => claim.startsWith("distrust:"))) {
    return false;
  }

  const viaWorkflow = workflows.some((workflow) => KNOWN_GOOD_WORKFLOWS.has(workflow));
  const viaBrand = brands.some((brand) => KNOWN_GOOD_BRANDS.has(brand));
  const viaOrg = organizations.some((org) => KNOWN_GOOD_ORGANIZATIONS.has(org));
  if (viaWorkflow || viaBrand || viaOrg) return true;

  // A manually imported profile with no claims is treated as untrusted until a
  // trusted workflow is attached or a vendor claim is verified. The single
  // legacy slot ships with a known-good workflow.
  return source === "legacy-settings-acp";
}

/** Convenience wrapper over a stored revision object. */
export function isAgentProfileRevisionTrusted(revision: AgentProfileRevision): boolean {
  return evaluateAgentProfileTrust({
    provenance: revision.provenance,
    trust: revision.trust,
  });
}
