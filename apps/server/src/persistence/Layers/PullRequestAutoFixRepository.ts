import { PullRequestAutoFixState } from "@synara/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  PullRequestAutoFixKey,
  PullRequestAutoFixRepository,
  type PullRequestAutoFixRepositoryShape,
  PullRequestAutoFixThreadInput,
} from "../Services/PullRequestAutoFixRepository.ts";

const makePullRequestAutoFixRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const Row = PullRequestAutoFixState.mapFields((fields) => ({
    ...fields,
    requestedPullRequestUrl: Schema.NullOr(Schema.String),
  }));
  const decodeRows = (rows: ReadonlyArray<typeof Row.Type>) =>
    rows.map(({ requestedPullRequestUrl, ...state }) => ({
      ...state,
      ...(requestedPullRequestUrl !== null ? { requestedPullRequestUrl } : {}),
    }));

  const listThreadRows = SqlSchema.findAll({
    Request: PullRequestAutoFixThreadInput,
    Result: Row,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        pull_request_url AS "pullRequestUrl",
        requested_pull_request_url AS "requestedPullRequestUrl",
        status AS "status",
        pause_reason AS "pauseReason",
        attempts AS "attempts",
        last_handled_head_sha AS "lastHandledHeadSha",
        updated_at AS "updatedAt"
      FROM pull_request_auto_fix
      WHERE thread_id = ${threadId}
      ORDER BY pull_request_url ASC
    `,
  });

  const listActiveRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Row,
    execute: () => sql`
      SELECT
        thread_id AS "threadId",
        pull_request_url AS "pullRequestUrl",
        requested_pull_request_url AS "requestedPullRequestUrl",
        status AS "status",
        pause_reason AS "pauseReason",
        attempts AS "attempts",
        last_handled_head_sha AS "lastHandledHeadSha",
        updated_at AS "updatedAt"
      FROM pull_request_auto_fix
      WHERE status <> 'paused'
      ORDER BY thread_id ASC, pull_request_url ASC
    `,
  });

  const upsertRow = SqlSchema.void({
    Request: PullRequestAutoFixState,
    execute: (state) => sql`
      INSERT INTO pull_request_auto_fix (
        thread_id,
        pull_request_url,
        requested_pull_request_url,
        status,
        pause_reason,
        attempts,
        last_handled_head_sha,
        updated_at
      )
      VALUES (
        ${state.threadId},
        ${state.pullRequestUrl},
        ${state.requestedPullRequestUrl ?? null},
        ${state.status},
        ${state.pauseReason},
        ${state.attempts},
        ${state.lastHandledHeadSha},
        ${state.updatedAt}
      )
      ON CONFLICT (thread_id, pull_request_url) DO UPDATE SET
        requested_pull_request_url = excluded.requested_pull_request_url,
        status = excluded.status,
        pause_reason = excluded.pause_reason,
        attempts = excluded.attempts,
        last_handled_head_sha = excluded.last_handled_head_sha,
        updated_at = excluded.updated_at
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: PullRequestAutoFixKey,
    execute: ({ threadId, pullRequestUrl }) => sql`
      DELETE FROM pull_request_auto_fix
      WHERE thread_id = ${threadId}
        AND pull_request_url = ${pullRequestUrl}
    `,
  });

  const listByThread: PullRequestAutoFixRepositoryShape["listByThread"] = (input) =>
    listThreadRows(input).pipe(
      Effect.map(decodeRows),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PullRequestAutoFixRepository.listByThread:query",
          "PullRequestAutoFixRepository.listByThread:decodeRows",
        ),
      ),
    );

  const listActive: PullRequestAutoFixRepositoryShape["listActive"] = () =>
    listActiveRows(undefined).pipe(
      Effect.map(decodeRows),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PullRequestAutoFixRepository.listActive:query",
          "PullRequestAutoFixRepository.listActive:decodeRows",
        ),
      ),
    );

  const upsert: PullRequestAutoFixRepositoryShape["upsert"] = (state) =>
    upsertRow(state).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PullRequestAutoFixRepository.upsert:query",
          "PullRequestAutoFixRepository.upsert:encodeRequest",
        ),
      ),
    );

  const deleteState: PullRequestAutoFixRepositoryShape["delete"] = (input) =>
    deleteRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PullRequestAutoFixRepository.delete:query",
          "PullRequestAutoFixRepository.delete:encodeRequest",
        ),
      ),
    );

  return {
    listByThread,
    listActive,
    upsert,
    delete: deleteState,
  } satisfies PullRequestAutoFixRepositoryShape;
});

export const PullRequestAutoFixRepositoryLive = Layer.effect(
  PullRequestAutoFixRepository,
  makePullRequestAutoFixRepository,
);
