import type { AgentProfile, AgentProfileRevision, AgentProfileStatus } from "@synara/contracts";
import {
  AgentProfile as AgentProfileSchema,
  AgentProfileRevision as AgentProfileRevisionSchema,
} from "@synara/contracts";
import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

interface AgentProfileRow {
  readonly profileId: string;
  readonly name: string;
  readonly currentRevisionId: string;
  readonly status: AgentProfileStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AgentProfileRevisionRow {
  readonly revisionId: string;
  readonly contentHash: string;
  readonly payload: string;
  readonly createdAt: string;
}

export interface AgentProfileRepositoryShape {
  readonly listProfiles: () => Effect.Effect<ReadonlyArray<AgentProfile>, Error>;
  readonly getProfile: (profileId: string) => Effect.Effect<Option.Option<AgentProfile>, Error>;
  readonly getProfileRevisions: (
    profileId: string,
  ) => Effect.Effect<ReadonlyArray<AgentProfileRevision>, Error>;
  readonly getRevision: (
    revisionId: string,
  ) => Effect.Effect<Option.Option<AgentProfileRevision>, Error>;
  readonly createProfile: (input: {
    readonly profile: AgentProfile;
    readonly revision: AgentProfileRevision;
    readonly contentHash: string;
  }) => Effect.Effect<{ readonly revisionReused: boolean }, Error>;
  readonly repointProfileRevision: (input: {
    readonly profileId: string;
    readonly currentRevisionId: string;
    readonly updatedAt: string;
    readonly revision: AgentProfileRevision;
    readonly contentHash: string;
  }) => Effect.Effect<{ readonly revisionReused: boolean }, Error>;
  readonly tombstoneProfile: (
    profileId: string,
    updatedAt: string,
  ) => Effect.Effect<Option.Option<AgentProfile>, Error>;
}

export class AgentProfileRepository extends ServiceMap.Service<
  AgentProfileRepository,
  AgentProfileRepositoryShape
>()("synara/externalAgents/AgentProfileRepository") {}

const repositoryError = (operation: string) => (cause: unknown) =>
  new Error(`External agent profile repository failed during ${operation}.`, { cause });

function parseRevisionPayload(value: string): AgentProfileRevision {
  return Schema.decodeUnknownSync(AgentProfileRevisionSchema)(JSON.parse(value) as unknown);
}

function toProfile(row: AgentProfileRow): AgentProfile {
  return Schema.decodeUnknownSync(AgentProfileSchema)(row);
}

export const makeAgentProfileRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectProfile = (profileId: string) => sql<AgentProfileRow>`
    SELECT
      profile_id AS "profileId",
      name,
      current_revision_id AS "currentRevisionId",
      status,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM external_agent_profiles
    WHERE profile_id = ${profileId}
  `;

  const getProfile: AgentProfileRepositoryShape["getProfile"] = (profileId) =>
    selectProfile(profileId).pipe(
      Effect.map((rows) => (rows[0] ? Option.some(toProfile(rows[0])) : Option.none())),
      Effect.mapError(repositoryError("getProfile")),
    );

  const getRevision: AgentProfileRepositoryShape["getRevision"] = (revisionId) =>
    sql<AgentProfileRevisionRow>`
      SELECT
        revision_id AS "revisionId",
        content_hash AS "contentHash",
        payload,
        created_at AS "createdAt"
      FROM external_agent_profile_revisions
      WHERE revision_id = ${revisionId}
    `.pipe(
      Effect.map((rows) =>
        rows[0] ? Option.some(parseRevisionPayload(rows[0].payload)) : Option.none(),
      ),
      Effect.mapError(repositoryError("getRevision")),
    );

  const listProfiles: AgentProfileRepositoryShape["listProfiles"] = () =>
    sql<AgentProfileRow>`
      SELECT
        profile_id AS "profileId",
        name,
        current_revision_id AS "currentRevisionId",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM external_agent_profiles
      ORDER BY created_at ASC, profile_id ASC
    `.pipe(
      Effect.map((rows) => rows.map(toProfile)),
      Effect.mapError(repositoryError("listProfiles")),
    );

  // Walks the parent chain from the current revision, newest first. Revisions
  // are immutable rows; the parent link is recorded in the first revision that
  // carried the content, which is accurate for the common non-shared case.
  const getProfileRevisions: AgentProfileRepositoryShape["getProfileRevisions"] = (profileId) =>
    Effect.gen(function* () {
      const profile = yield* getProfile(profileId);
      if (Option.isNone(profile)) {
        return [] as ReadonlyArray<AgentProfileRevision>;
      }
      const revisions: AgentProfileRevision[] = [];
      let cursor: string | undefined = profile.value.currentRevisionId;
      while (cursor !== undefined) {
        const rows = yield* sql<AgentProfileRevisionRow>`
          SELECT
            revision_id AS "revisionId",
            content_hash AS "contentHash",
            payload,
            created_at AS "createdAt"
          FROM external_agent_profile_revisions
          WHERE revision_id = ${cursor}
        `;
        const row = rows[0];
        if (!row) {
          break;
        }
        const revision = parseRevisionPayload(row.payload);
        revisions.push(revision);
        cursor = revision.parentRevisionId;
      }
      return revisions;
    }).pipe(Effect.mapError(repositoryError("getProfileRevisions")));

  const insertRevisionIfAbsent = (input: {
    readonly revision: AgentProfileRevision;
    readonly contentHash: string;
  }): Effect.Effect<boolean, Error> =>
    Effect.gen(function* () {
      const existing = yield* sql<{ readonly revisionId: string }>`
      SELECT revision_id AS "revisionId"
      FROM external_agent_profile_revisions
      WHERE revision_id = ${input.revision.revisionId}
    `;
      if (existing.length > 0) {
        return true;
      }
      yield* sql`
      INSERT INTO external_agent_profile_revisions (
        revision_id, content_hash, payload, created_at
      ) VALUES (
        ${input.revision.revisionId},
        ${input.contentHash},
        ${JSON.stringify(input.revision)},
        ${input.revision.createdAt}
      )
    `;
      return false;
    });

  const createProfile: AgentProfileRepositoryShape["createProfile"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const revisionReused = yield* insertRevisionIfAbsent(input);
          yield* sql`
            INSERT INTO external_agent_profiles (
              profile_id, name, current_revision_id, status, created_at, updated_at
            ) VALUES (
              ${input.profile.profileId},
              ${input.profile.name},
              ${input.profile.currentRevisionId},
              ${input.profile.status},
              ${input.profile.createdAt},
              ${input.profile.updatedAt}
            )
          `;
          return { revisionReused };
        }),
      )
      .pipe(Effect.mapError(repositoryError("createProfile")));

  const repointProfileRevision: AgentProfileRepositoryShape["repointProfileRevision"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const revisionReused = yield* insertRevisionIfAbsent({
            revision: input.revision,
            contentHash: input.contentHash,
          });
          yield* sql`
            UPDATE external_agent_profiles
            SET current_revision_id = ${input.currentRevisionId},
                updated_at = ${input.updatedAt}
            WHERE profile_id = ${input.profileId}
          `;
          return { revisionReused };
        }),
      )
      .pipe(Effect.mapError(repositoryError("repointProfileRevision")));

  const tombstoneProfile: AgentProfileRepositoryShape["tombstoneProfile"] = (
    profileId,
    updatedAt,
  ) =>
    sql`
      UPDATE external_agent_profiles
      SET status = 'tombstoned', updated_at = ${updatedAt}
      WHERE profile_id = ${profileId}
    `.pipe(
      Effect.andThen(getProfile(profileId)),
      Effect.mapError(repositoryError("tombstoneProfile")),
    );

  return {
    listProfiles,
    getProfile,
    getProfileRevisions,
    getRevision,
    createProfile,
    repointProfileRevision,
    tombstoneProfile,
  } satisfies AgentProfileRepositoryShape;
});

export const AgentProfileRepositoryLive = Layer.effect(
  AgentProfileRepository,
  makeAgentProfileRepository,
);
