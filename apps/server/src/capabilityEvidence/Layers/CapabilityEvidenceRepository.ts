import type {
  CapabilityObservation,
  EffectiveCapabilityStateView,
  PolicySpec,
  RuntimeIdentitySignals,
  VerifierIdentity,
} from "@synara/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  CapabilityEvidenceRepository,
  type CapabilityEvidenceRepositoryShape,
} from "../Services/CapabilityEvidenceRepository.ts";

const repositoryError = (operation: string) => (cause: unknown) =>
  new Error(`Capability evidence repository failed during ${operation}.`, { cause });

interface ObservationRow {
  readonly observationId: string;
  readonly namespace: string;
  readonly capabilityId: string;
  readonly source: string;
  readonly outcome: string;
  readonly attribution: string;
  readonly runtimeIdentityJson: string | null;
  readonly verifierJson: string | null;
  readonly policyJson: string | null;
  readonly observedAt: string;
  readonly runMetadataJson: string | null;
}

interface EffectiveStateRow {
  readonly namespace: string;
  readonly capabilityId: string;
  readonly state: string;
  readonly advertised: number;
  readonly policyJson: string | null;
  readonly lastObservationAt: string | null;
  readonly lastObservationId: string | null;
  readonly derivedAt: string;
}

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const toObservation = (row: ObservationRow): CapabilityObservation => ({
  observationId: row.observationId,
  namespace: row.namespace,
  capabilityId: row.capabilityId as CapabilityObservation["capabilityId"],
  source: row.source as CapabilityObservation["source"],
  outcome: row.outcome as CapabilityObservation["outcome"],
  attribution: row.attribution as CapabilityObservation["attribution"],
  runtime: parseJson<RuntimeIdentitySignals>(row.runtimeIdentityJson, {}),
  verifier: parseJson<VerifierIdentity>(row.verifierJson, { verifierId: "unknown" }),
  policy: parseJson<PolicySpec>(row.policyJson, { version: "unknown", params: {} }),
  observedAt: row.observedAt,
  run: row.runMetadataJson === null ? undefined : parseJson(row.runMetadataJson, undefined),
});

const toEffectiveState = (row: EffectiveStateRow): EffectiveCapabilityStateView => ({
  namespace: row.namespace,
  capabilityId: row.capabilityId as EffectiveCapabilityStateView["capabilityId"],
  state: row.state as EffectiveCapabilityStateView["state"],
  advertised: row.advertised === 1,
  policy: parseJson<PolicySpec>(row.policyJson, { version: "unknown", params: {} }),
  lastObservationAt: row.lastObservationAt ?? undefined,
  lastObservationId: row.lastObservationId ?? undefined,
  derivedAt: row.derivedAt,
});

export const makeCapabilityEvidenceRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const appendObservation: CapabilityEvidenceRepositoryShape["appendObservation"] = (input) =>
    sql`
      INSERT INTO capability_observations (
        observation_id, namespace, capability_id, source, outcome, attribution,
        runtime_identity_json, verifier_json, policy_json, observed_at, run_metadata_json
      ) VALUES (
        ${input.observation.observationId}, ${input.observation.namespace},
        ${input.observation.capabilityId}, ${input.observation.source},
        ${input.observation.outcome}, ${input.observation.attribution},
        ${JSON.stringify(input.observation.runtime)},
        ${JSON.stringify(input.observation.verifier)},
        ${JSON.stringify(input.observation.policy)},
        ${input.observation.observedAt},
        ${input.observation.run === undefined ? null : JSON.stringify(input.observation.run)}
      )
    `.pipe(Effect.asVoid, Effect.mapError(repositoryError("appendObservation")));

  const listObservations: CapabilityEvidenceRepositoryShape["listObservations"] = (input) =>
    (input.capabilityId === undefined
      ? sql<ObservationRow>`
          SELECT
            observation_id AS "observationId", namespace, capability_id AS "capabilityId",
            source, outcome, attribution,
            runtime_identity_json AS "runtimeIdentityJson",
            verifier_json AS "verifierJson", policy_json AS "policyJson",
            observed_at AS "observedAt", run_metadata_json AS "runMetadataJson"
          FROM capability_observations
          WHERE namespace = ${input.namespace}
          ORDER BY observed_at DESC, observation_id DESC
        `
      : sql<ObservationRow>`
          SELECT
            observation_id AS "observationId", namespace, capability_id AS "capabilityId",
            source, outcome, attribution,
            runtime_identity_json AS "runtimeIdentityJson",
            verifier_json AS "verifierJson", policy_json AS "policyJson",
            observed_at AS "observedAt", run_metadata_json AS "runMetadataJson"
          FROM capability_observations
          WHERE namespace = ${input.namespace} AND capability_id = ${input.capabilityId}
          ORDER BY observed_at DESC, observation_id DESC
        `
    ).pipe(
      Effect.map((rows) => rows.map(toObservation)),
      Effect.mapError(repositoryError("listObservations")),
    );

  const latestRuntimeIdentity: CapabilityEvidenceRepositoryShape["latestRuntimeIdentity"] = (
    namespace,
  ) =>
    sql<{ readonly runtimeIdentityJson: string | null }>`
      SELECT runtime_identity_json AS "runtimeIdentityJson"
      FROM capability_observations
      WHERE namespace = ${namespace}
      ORDER BY observed_at DESC, observation_id DESC
      LIMIT 1
    `.pipe(
      Effect.map((rows) =>
        rows[0]
          ? parseJson<RuntimeIdentitySignals | null>(rows[0].runtimeIdentityJson, null)
          : null,
      ),
      Effect.mapError(repositoryError("latestRuntimeIdentity")),
    );

  const latestVerifierIdentity: CapabilityEvidenceRepositoryShape["latestVerifierIdentity"] = (
    namespace,
  ) =>
    sql<{ readonly verifierJson: string | null }>`
      SELECT verifier_json AS "verifierJson"
      FROM capability_observations
      WHERE namespace = ${namespace}
      ORDER BY observed_at DESC, observation_id DESC
      LIMIT 1
    `.pipe(
      Effect.map((rows) =>
        rows[0] ? parseJson<VerifierIdentity | null>(rows[0].verifierJson, null) : null,
      ),
      Effect.mapError(repositoryError("latestVerifierIdentity")),
    );

  const latestPolicySpec: CapabilityEvidenceRepositoryShape["latestPolicySpec"] = (namespace) =>
    sql<{ readonly policyJson: string | null }>`
      SELECT policy_json AS "policyJson"
      FROM capability_observations
      WHERE namespace = ${namespace}
      ORDER BY observed_at DESC, observation_id DESC
      LIMIT 1
    `.pipe(
      Effect.map((rows) =>
        rows[0] ? parseJson<PolicySpec | null>(rows[0].policyJson, null) : null,
      ),
      Effect.mapError(repositoryError("latestPolicySpec")),
    );

  const upsertEffectiveState: CapabilityEvidenceRepositoryShape["upsertEffectiveState"] = (input) =>
    sql`
      INSERT INTO capability_effective_states (
        namespace, capability_id, state, advertised, policy_json,
        last_observation_at, last_observation_id, derived_at
      ) VALUES (
        ${input.state.namespace}, ${input.state.capabilityId}, ${input.state.state},
        ${input.state.advertised ? 1 : 0}, ${JSON.stringify(input.state.policy)},
        ${input.state.lastObservationAt ?? null}, ${input.state.lastObservationId ?? null},
        ${input.state.derivedAt}
      )
      ON CONFLICT (namespace, capability_id) DO UPDATE SET
        state = excluded.state,
        advertised = excluded.advertised,
        policy_json = excluded.policy_json,
        last_observation_at = excluded.last_observation_at,
        last_observation_id = excluded.last_observation_id,
        derived_at = excluded.derived_at
    `.pipe(Effect.asVoid, Effect.mapError(repositoryError("upsertEffectiveState")));

  const getEffectiveState: CapabilityEvidenceRepositoryShape["getEffectiveState"] = (input) =>
    sql<EffectiveStateRow>`
      SELECT
        namespace, capability_id AS "capabilityId", state, advertised, policy_json AS "policyJson",
        last_observation_at AS "lastObservationAt", last_observation_id AS "lastObservationId",
        derived_at AS "derivedAt"
      FROM capability_effective_states
      WHERE namespace = ${input.namespace} AND capability_id = ${input.capabilityId}
      LIMIT 1
    `.pipe(
      Effect.map((rows) => (rows[0] ? toEffectiveState(rows[0]) : null)),
      Effect.mapError(repositoryError("getEffectiveState")),
    );

  const clearEffectiveStates: CapabilityEvidenceRepositoryShape["clearEffectiveStates"] = (input) =>
    sql`
      DELETE FROM capability_effective_states
      WHERE namespace = ${input.namespace}
    `.pipe(Effect.asVoid, Effect.mapError(repositoryError("clearEffectiveStates")));

  return {
    appendObservation,
    listObservations,
    latestRuntimeIdentity,
    latestVerifierIdentity,
    latestPolicySpec,
    upsertEffectiveState,
    getEffectiveState,
    clearEffectiveStates,
  } satisfies CapabilityEvidenceRepositoryShape;
});

export const CapabilityEvidenceRepositoryLive = Layer.effect(
  CapabilityEvidenceRepository,
  makeCapabilityEvidenceRepository,
);
