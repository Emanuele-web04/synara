// FILE: agentProfileTrust.ts
// Purpose: Pure, deterministic provenance-based trust evaluation shared by the
// profile lifecycle service and the session-launch gate. Kept dependency-free
// so both services can import the same verdict without a cycle.
// Layer: Server external agents
// Exports: evaluateAgentProfileTrust, profileEvidenceNamespace,
//          assertSessionAllowed (the single shared session-launch gate), and
//          ProfileSessionRefused (its refusal error)

import type { AgentProfile, AgentProfileRevision } from "@synara/contracts";
import type { AgentProfileTrust } from "@synara/contracts";

/**
 * Refusal raised by {@link assertSessionAllowed} when a session start must be
 * blocked (quarantined/retired profile, or an untrusted profile that needs
 * credential release). The `code` is the single source of the profile-level
 * error codes exposed to consumers; successful launches never produce one.
 */
export class ProfileSessionRefused extends Error {
  readonly _tag = "ProfileSessionRefused";
  readonly code: "profile-quarantined" | "profile-removed" | "profile-untrusted";
  constructor(input: {
    readonly code: "profile-quarantined" | "profile-removed" | "profile-untrusted";
    readonly message: string;
  }) {
    super(input.message);
    this.name = "ProfileSessionRefused";
    this.code = input.code;
  }
}

/**
 * Capability-evidence namespace for a profile. Evidence rows are keyed by this
 * namespace; the conformance runner and evidence service both write to it.
 */
export const profileEvidenceNamespace = (profileId: string, revisionId: string): string =>
  `external:agentprofile:${profileId}:revision:${revisionId}`;

/** Credential release requires an explicit owner grant; distrust overrides it. */
export function evaluateAgentProfileTrust(input: {
  readonly provenance?: { readonly source?: string; readonly version?: string | undefined };
  readonly trust?: AgentProfileTrust | undefined;
}): boolean {
  const claims = input.trust ?? {};
  const labels = [
    ...(claims.workflows ?? []),
    ...(claims.brands ?? []),
    ...(claims.organizations ?? []),
  ];
  if (labels.some((claim) => claim.startsWith("distrust:"))) return false;
  // These fields are accepted only through owner-authorized management RPCs.
  // Self-asserted provenance or vendor labels are not credential grants.
  return claims.allowCredentialAccess === true;
}

/** Convenience wrapper over a stored revision object. */
export function isAgentProfileRevisionTrusted(revision: AgentProfileRevision): boolean {
  return evaluateAgentProfileTrust({
    provenance: revision.provenance,
    trust: revision.trust,
  });
}

const hasCredentialRefs = (revision: AgentProfileRevision): boolean =>
  (revision.credentialRefs?.length ?? 0) > 0 ||
  (revision.launch.kind === "command" && (revision.launch.envRefs?.length ?? 0) > 0);

/**
 * The single shared session-launch gate (KAR-529 AC5). Refuses new sessions for
 * quarantined/retired profiles, and refuses credential release to an untrusted
 * profile that needs credentials (provenance-based trust). Both the profile
 * service's `resolveSessionLaunch` and the lifecycle service's
 * `assertSessionAllowed` delegate here so the trust/status rules live in one
 * place. Pure: no services, no I/O.
 */
export function assertSessionAllowed(input: {
  readonly profile: AgentProfile;
  readonly revision: AgentProfileRevision;
}): asserts input is {
  readonly profile: AgentProfile;
  readonly revision: AgentProfileRevision;
} {
  const { profile, revision } = input;
  if (profile.status === "quarantined") {
    throw new ProfileSessionRefused({
      code: "profile-quarantined",
      message: `External agent profile "${profile.name}" is quarantined; new sessions are blocked until it is re-certified.`,
    });
  }
  if (profile.status === "retired") {
    throw new ProfileSessionRefused({
      code: "profile-removed",
      message: `External agent profile "${profile.name}" has been removed; new sessions are disabled.`,
    });
  }
  if (hasCredentialRefs(revision) && !isAgentProfileRevisionTrusted(revision)) {
    throw new ProfileSessionRefused({
      code: "profile-untrusted",
      message: `External agent profile "${profile.name}" is not trusted for credential release; attach a trusted workflow or verified vendor claim first.`,
    });
  }
}
