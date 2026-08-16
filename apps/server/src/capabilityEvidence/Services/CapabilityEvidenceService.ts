import type {
  CapabilityAdvertisement,
  CapabilityEvidenceInvalidateInput,
  CapabilityEvidenceInvalidateResult,
  CapabilityEvidenceQuery,
  CapabilityEvidenceQueryResult,
  CapabilityEvidenceRecordInput,
  CapabilityEvidenceRecordResult,
  CapabilityObservation,
} from "@synara/contracts";
import { Data, Effect, Random, ServiceMap } from "effect";

import { CapabilityEvidenceRepository } from "./CapabilityEvidenceRepository.ts";
import {
  CAPABILITY_EVIDENCE_POLICY_VERSION,
  CapabilityPolicyEngine,
} from "./CapabilityPolicyEngine.ts";

export class CapabilityEvidenceError extends Data.TaggedError("CapabilityEvidenceError")<{
  readonly code: "invalid_input" | "repository_error" | "not_found";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface CapabilityEvidenceServiceShape {
  readonly record: (
    input: CapabilityEvidenceRecordInput,
  ) => Effect.Effect<CapabilityEvidenceRecordResult, CapabilityEvidenceError>;
  readonly query: (
    input: CapabilityEvidenceQuery,
  ) => Effect.Effect<CapabilityEvidenceQueryResult, CapabilityEvidenceError>;
  readonly invalidate: (
    input: CapabilityEvidenceInvalidateInput,
  ) => Effect.Effect<CapabilityEvidenceInvalidateResult, CapabilityEvidenceError>;
}

export class CapabilityEvidenceService extends ServiceMap.Service<
  CapabilityEvidenceService,
  CapabilityEvidenceServiceShape
>()("synara/capabilityEvidence/Services/CapabilityEvidenceService") {}

const toRepositoryError = (operation: string) => (cause: unknown) =>
  new CapabilityEvidenceError({
    code: "repository_error",
    message: `Capability evidence ${operation} failed.`,
    ...(cause instanceof Error ? { cause } : {}),
  });

const randomObservationId = (namespace: string, capabilityId: string, now: string) =>
  Effect.gen(function* () {
    const suffix = yield* Random.nextIntBetween(1_000_000, 9_999_999);
    return `${namespace}:${capabilityId}:${now}:${suffix}`;
  });

export const makeCapabilityEvidenceService = Effect.gen(function* () {
  const repository = yield* CapabilityEvidenceRepository;
  const policyEngine = yield* CapabilityPolicyEngine;

  const record: CapabilityEvidenceServiceShape["record"] = (input) =>
    Effect.gen(function* () {
      const observationId = yield* randomObservationId(
        input.namespace,
        input.capabilityId,
        input.observedAt,
      );
      const observation: CapabilityObservation = {
        observationId,
        namespace: input.namespace,
        capabilityId: input.capabilityId,
        source: input.source,
        outcome: input.outcome,
        attribution: input.attribution,
        runtime: input.runtime,
        verifier: input.verifier,
        policy: input.policy,
        observedAt: input.observedAt,
        run: input.run,
      };
      yield* repository
        .appendObservation({ observation })
        .pipe(Effect.mapError(toRepositoryError("record")));
      return { observation } satisfies CapabilityEvidenceRecordResult;
    });

  const query: CapabilityEvidenceServiceShape["query"] = (input) =>
    Effect.gen(function* () {
      const observations = yield* repository
        .listObservations(
          input.capabilityId === undefined
            ? { namespace: input.namespace }
            : { namespace: input.namespace, capabilityId: input.capabilityId },
        )
        .pipe(Effect.mapError(toRepositoryError("query")));

      // Separate the advertisement (protocol claims) from verification evidence.
      // `advertised` is true when the agent's latest claim asserts the capability;
      // the verdict derives only from non-claim observations (see the policy
      // engine), so `advertised: true` + `state: "broken"` is representable.
      const latestClaim = [...observations]
        .filter((observation) => observation.source === "protocol-claim")
        .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
        .at(-1);
      const advertisement: CapabilityAdvertisement | undefined =
        latestClaim === undefined
          ? undefined
          : {
              capabilityId: latestClaim.capabilityId,
              advertised: latestClaim.outcome === "pass",
              advertisedAt: latestClaim.observedAt,
            };

      // A single derived view only makes sense when the observation set belongs
      // to one capability (either explicitly queried or naturally singular).
      const capabilityIds = new Set(observations.map((observation) => observation.capabilityId));
      const state =
        input.capabilityId !== undefined || capabilityIds.size === 1
          ? policyEngine.deriveEffectiveStateView({
              namespace: input.namespace,
              observations,
              policy: { version: CAPABILITY_EVIDENCE_POLICY_VERSION, params: {} },
              advertisement,
              derivedAt: new Date().toISOString(),
            })
          : undefined;
      return { observations, state } satisfies CapabilityEvidenceQueryResult;
    });

  const invalidate: CapabilityEvidenceServiceShape["invalidate"] = (input) =>
    Effect.gen(function* () {
      yield* repository
        .clearEffectiveStates(input)
        .pipe(Effect.mapError(toRepositoryError("invalidate")));
      return { invalidated: 1 } satisfies CapabilityEvidenceInvalidateResult;
    });

  return { record, query, invalidate } satisfies CapabilityEvidenceServiceShape;
});
