import type {
  CapabilityId,
  CapabilityObservation,
  EffectiveCapabilityStateView,
  RuntimeIdentitySignals,
  VerifierIdentity,
  PolicySpec,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface CapabilityObservationRecord extends CapabilityObservation {}

export interface CapabilityEvidenceRepositoryShape {
  /**
   * Append one immutable observation. Never updates or deletes prior rows.
   */
  readonly appendObservation: (input: {
    readonly observation: CapabilityObservation;
  }) => Effect.Effect<void, Error>;
  /**
   * List observations for a profile (and optionally a single capability),
   * newest first.
   */
  readonly listObservations: (input: {
    readonly namespace: string;
    readonly capabilityId?: CapabilityId;
  }) => Effect.Effect<ReadonlyArray<CapabilityObservation>, Error>;
  /**
   * Latest observed runtime identity signals for a profile. Used to detect
   * drift when a new observation arrives with different signals.
   */
  readonly latestRuntimeIdentity: (
    namespace: string,
  ) => Effect.Effect<RuntimeIdentitySignals | null, Error>;
  /**
   * Latest verifier identity + harness version seen for a profile.
   */
  readonly latestVerifierIdentity: (
    namespace: string,
  ) => Effect.Effect<VerifierIdentity | null, Error>;
  /**
   * Latest policy spec seen for a profile.
   */
  readonly latestPolicySpec: (namespace: string) => Effect.Effect<PolicySpec | null, Error>;
  /**
   * Persist a single effective-state snapshot keyed by (namespace, capability).
   * Stored as a derived cache, never as source of truth — re-derivation recomputes it.
   */
  readonly upsertEffectiveState: (input: {
    readonly state: EffectiveCapabilityStateView;
  }) => Effect.Effect<void, Error>;
  /**
   * Read the persisted effective state for a capability, if any.
   */
  readonly getEffectiveState: (input: {
    readonly namespace: string;
    readonly capabilityId: CapabilityId;
  }) => Effect.Effect<EffectiveCapabilityStateView | null, Error>;
  /**
   * Delete effective-state cache rows for a profile (used by invalidation).
   * Does not touch observation rows.
   */
  readonly clearEffectiveStates: (input: {
    readonly namespace: string;
  }) => Effect.Effect<void, Error>;
}

export class CapabilityEvidenceRepository extends ServiceMap.Service<
  CapabilityEvidenceRepository,
  CapabilityEvidenceRepositoryShape
>()("synara/capabilityEvidence/Services/CapabilityEvidenceRepository") {}
