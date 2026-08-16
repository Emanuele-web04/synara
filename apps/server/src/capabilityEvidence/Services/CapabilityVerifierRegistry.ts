import { Effect, ServiceMap } from "effect";

import type {
  CapabilityId,
  EvidenceOutcome,
  RuntimeIdentitySignals,
  VerifierIdentity,
} from "@synara/contracts";

export type CapabilityAttribution =
  | "agent"
  | "synara"
  | "auth"
  | "network"
  | "environment"
  | "unknown";

export interface CapabilityVerificationRequest {
  readonly namespace: string;
  readonly capabilityId: CapabilityId;
  readonly runtime: RuntimeIdentitySignals;
  readonly verifier: VerifierIdentity;
  readonly advertisement: { readonly advertised: boolean } | undefined;
}

export interface CapabilityVerificationOutcome {
  readonly capabilityId: CapabilityId;
  readonly outcome: EvidenceOutcome;
  readonly attribution: CapabilityAttribution;
  readonly detail?: string;
}

export interface CapabilityVerifierShape {
  readonly id: string;
  readonly verifies: (
    request: CapabilityVerificationRequest,
  ) => Effect.Effect<CapabilityVerificationOutcome, Error>;
}

export interface CapabilityVerifierRegistryShape {
  readonly register: (verifier: CapabilityVerifierShape) => void;
  readonly resolve: (request: {
    readonly capabilityId: CapabilityId;
    readonly runtime: RuntimeIdentitySignals | undefined;
  }) => CapabilityVerifierShape | undefined;
  readonly list: () => ReadonlyArray<CapabilityVerifierShape>;
}

export class CapabilityVerifierRegistry extends ServiceMap.Service<
  CapabilityVerifierRegistry,
  CapabilityVerifierRegistryShape
>()("synara/capabilityEvidence/Services/CapabilityVerifierRegistry") {}

/**
 * Empty seam. KAR-524 registers real bindings (ACP conformance, production
 * observers, vendor attestations) and keys them by (capabilityId, runtime
 * fingerprint). Until then `resolve` always answers `undefined`, which the
 * service treats as "no verifier available → no new evidence".
 */
export const makeCapabilityVerifierRegistry = Effect.sync((): CapabilityVerifierRegistryShape => {
  const verifiers: CapabilityVerifierShape[] = [];
  return {
    register: (verifier) => {
      verifiers.push(verifier);
    },
    resolve: () => undefined,
    list: () => [...verifiers],
  };
});
