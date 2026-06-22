import { ReviewPullRequestSummary } from "@t3tools/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceDecodeCauseError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ReviewPullRequestStore,
  type ReviewPullRequestStoreShape,
  type ReviewPullRequestUpsert,
  type ReviewSyncStateRow,
} from "../Services/ReviewPullRequestStore.ts";

const decodeSummary = Schema.decodeUnknownEffect(ReviewPullRequestSummary);

interface SyncStateSqlRow {
  readonly repositoryId: string;
  readonly tokenIdentity: string;
  readonly lastSeenUpdatedAt: string | null;
  readonly lastSyncedAt: number | null;
  readonly fullResyncedAt: number | null;
  readonly lastGraphqlCost: number | null;
  readonly pointsRemaining: number | null;
  readonly rateResetAt: number | null;
}

function updatedAtMs(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function decodeSummaryRows(
  rows: ReadonlyArray<{ readonly summaryJson: string }>,
  operation: string,
) {
  return Effect.forEach(rows, (row) =>
    Effect.try({
      try: () => JSON.parse(row.summaryJson) as unknown,
      catch: toPersistenceDecodeCauseError(`${operation}:json`),
    }).pipe(
      Effect.flatMap((parsed) =>
        decodeSummary(parsed).pipe(
          Effect.mapError(toPersistenceDecodeCauseError(`${operation}:decode`)),
        ),
      ),
    ),
  );
}

function neutralizableIn(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return values.length > 0 ? values : [""];
}

const makeReviewPullRequestStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const writePullRequest = (input: ReviewPullRequestUpsert) => {
    const s = input.summary;
    const labels = s.labels ?? [];
    const assignees = s.assignees ?? [];
    const reviewRequests = s.reviewRequests ?? [];
    return Effect.gen(function* () {
      yield* sql`
        INSERT INTO review_pull_requests (
          repository_id, number, state, is_draft, review_decision, checks_status,
          lane, author, base_branch, head_branch, head_selector, updated_at,
          updated_at_ms, title, url, additions, deletions, content_hash,
          summary_json, token_identity, synced_at, tombstoned_at
        )
        VALUES (
          ${input.repositoryId}, ${s.number}, ${s.state}, ${s.isDraft ? 1 : 0},
          ${s.reviewDecision ?? null}, ${s.checksStatus}, ${input.lane}, ${s.author},
          ${s.baseBranch}, ${s.headBranch}, ${s.headSelector ?? null}, ${s.updatedAt},
          ${updatedAtMs(s.updatedAt)}, ${s.title}, ${s.url}, ${s.additions}, ${s.deletions},
          ${input.contentHash}, ${JSON.stringify(s)}, ${input.tokenIdentity}, ${input.syncedAt},
          NULL
        )
        ON CONFLICT (repository_id, number)
        DO UPDATE SET
          state = excluded.state,
          is_draft = excluded.is_draft,
          review_decision = excluded.review_decision,
          checks_status = excluded.checks_status,
          lane = excluded.lane,
          author = excluded.author,
          base_branch = excluded.base_branch,
          head_branch = excluded.head_branch,
          head_selector = excluded.head_selector,
          updated_at = excluded.updated_at,
          updated_at_ms = excluded.updated_at_ms,
          title = excluded.title,
          url = excluded.url,
          additions = excluded.additions,
          deletions = excluded.deletions,
          content_hash = excluded.content_hash,
          summary_json = excluded.summary_json,
          token_identity = excluded.token_identity,
          synced_at = excluded.synced_at,
          tombstoned_at = NULL
      `;
      yield* sql`
        DELETE FROM review_pull_request_labels
        WHERE repository_id = ${input.repositoryId} AND number = ${s.number}
      `;
      yield* Effect.forEach(
        labels,
        (label) => sql`
          INSERT INTO review_pull_request_labels (repository_id, number, label)
          VALUES (${input.repositoryId}, ${s.number}, ${label})
          ON CONFLICT (repository_id, number, label) DO NOTHING
        `,
        { discard: true },
      );
      yield* sql`
        DELETE FROM review_pull_request_assignees
        WHERE repository_id = ${input.repositoryId} AND number = ${s.number}
      `;
      yield* Effect.forEach(
        assignees,
        (login) => sql`
          INSERT INTO review_pull_request_assignees (repository_id, number, login)
          VALUES (${input.repositoryId}, ${s.number}, ${login})
          ON CONFLICT (repository_id, number, login) DO NOTHING
        `,
        { discard: true },
      );
      yield* sql`
        DELETE FROM review_pull_request_review_requests
        WHERE repository_id = ${input.repositoryId} AND number = ${s.number}
      `;
      yield* Effect.forEach(
        reviewRequests,
        (login) => sql`
          INSERT INTO review_pull_request_review_requests (repository_id, number, login)
          VALUES (${input.repositoryId}, ${s.number}, ${login})
          ON CONFLICT (repository_id, number, login) DO NOTHING
        `,
        { discard: true },
      );
    });
  };

  const upsertPullRequest: ReviewPullRequestStoreShape["upsertPullRequest"] = (input) =>
    sql
      .withTransaction(writePullRequest(input))
      .pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("ReviewPullRequestStore.upsertPullRequest")),
      );

  const upsertPullRequests: ReviewPullRequestStoreShape["upsertPullRequests"] = (inputs) =>
    inputs.length === 0
      ? Effect.void
      : sql
          .withTransaction(Effect.forEach(inputs, writePullRequest, { discard: true }))
          .pipe(
            Effect.asVoid,
            Effect.mapError(toPersistenceSqlError("ReviewPullRequestStore.upsertPullRequests")),
          );

  const hasOpenPullRequests: ReviewPullRequestStoreShape["hasOpenPullRequests"] = (input) =>
    sql<{ readonly present: number }>`
      SELECT 1 AS "present"
      FROM review_pull_requests
      WHERE repository_id = ${input.repositoryId}
        AND state = 'open'
        AND tombstoned_at IS NULL
      LIMIT 1
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ReviewPullRequestStore.hasOpenPullRequests:query")),
      Effect.map((rows) => rows.length > 0),
    );

  const getLane: ReviewPullRequestStoreShape["getLane"] = (input) =>
    sql<{ readonly summaryJson: string }>`
      SELECT summary_json AS "summaryJson"
      FROM review_pull_requests
      WHERE repository_id = ${input.repositoryId}
        AND lane = ${input.lane}
        AND state = 'open'
        AND tombstoned_at IS NULL
      ORDER BY updated_at_ms DESC
      LIMIT ${input.limit}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ReviewPullRequestStore.getLane:query")),
      Effect.flatMap((rows) => decodeSummaryRows(rows, "ReviewPullRequestStore.getLane")),
    );

  const queryPullRequests: ReviewPullRequestStoreShape["queryPullRequests"] = (input) => {
    const lanes = input.lanes ?? [];
    const authors = input.authors ?? [];
    const baseBranches = input.baseBranches ?? [];
    const headBranches = input.headBranches ?? [];
    const labels = input.labels ?? [];
    const assignees = input.assignees ?? [];
    const flag = (on: boolean) => (on ? 1 : 0);
    // ORDER BY is a controlled enum, never user input.
    const orderBy = sql.unsafe(
      input.sort === "size"
        ? "(pr.additions + pr.deletions) DESC, pr.updated_at_ms DESC"
        : "pr.updated_at_ms DESC",
    );
    return sql<{ readonly summaryJson: string }>`
      SELECT pr.summary_json AS "summaryJson"
      FROM review_pull_requests pr
      WHERE pr.repository_id = ${input.repositoryId}
        AND pr.tombstoned_at IS NULL
        AND (${flag(input.state === "all")} = 1 OR pr.state = ${input.state})
        AND (${flag(lanes.length === 0)} = 1 OR pr.lane IN ${sql.in(neutralizableIn(lanes))})
        AND (${flag(authors.length === 0)} = 1 OR pr.author IN ${sql.in(neutralizableIn(authors))})
        AND (${flag(baseBranches.length === 0)} = 1
          OR pr.base_branch IN ${sql.in(neutralizableIn(baseBranches))})
        AND (${flag(headBranches.length === 0)} = 1
          OR pr.head_branch IN ${sql.in(neutralizableIn(headBranches))}
          OR pr.head_selector IN ${sql.in(neutralizableIn(headBranches))})
        AND (${flag(input.draft === true)} = 0 OR pr.is_draft = 1)
        AND (${flag(labels.length === 0)} = 1 OR EXISTS (
          SELECT 1 FROM review_pull_request_labels l
          WHERE l.repository_id = pr.repository_id AND l.number = pr.number
            AND l.label IN ${sql.in(neutralizableIn(labels))}
        ))
        AND (${flag(assignees.length === 0)} = 1 OR EXISTS (
          SELECT 1 FROM review_pull_request_assignees a
          WHERE a.repository_id = pr.repository_id AND a.number = pr.number
            AND a.login IN ${sql.in(neutralizableIn(assignees))}
        ))
        AND (${flag(input.reviewRequested === undefined)} = 1 OR EXISTS (
          SELECT 1 FROM review_pull_request_review_requests r
          WHERE r.repository_id = pr.repository_id AND r.number = pr.number
            AND r.login = ${input.reviewRequested ?? ""}
        ))
      ORDER BY ${orderBy}
      LIMIT ${input.limit}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ReviewPullRequestStore.queryPullRequests:query")),
      Effect.flatMap((rows) => decodeSummaryRows(rows, "ReviewPullRequestStore.queryPullRequests")),
    );
  };

  const getOpenContentHashes: ReviewPullRequestStoreShape["getOpenContentHashes"] = (input) =>
    sql<{ readonly number: number; readonly contentHash: string }>`
      SELECT number, content_hash AS "contentHash"
      FROM review_pull_requests
      WHERE repository_id = ${input.repositoryId}
        AND state = 'open'
        AND tombstoned_at IS NULL
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ReviewPullRequestStore.getOpenContentHashes:query")),
      Effect.map((rows) => new Map(rows.map((row) => [row.number, row.contentHash] as const))),
    );

  const tombstoneExcept: ReviewPullRequestStoreShape["tombstoneExcept"] = (input) =>
    (input.keepNumbers.length === 0
      ? sql`
          UPDATE review_pull_requests
          SET tombstoned_at = ${input.at}
          WHERE repository_id = ${input.repositoryId}
            AND state = 'open'
            AND tombstoned_at IS NULL
        `
      : sql`
          UPDATE review_pull_requests
          SET tombstoned_at = ${input.at}
          WHERE repository_id = ${input.repositoryId}
            AND state = 'open'
            AND tombstoned_at IS NULL
            AND number NOT IN ${sql.in(input.keepNumbers)}
        `
    ).pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ReviewPullRequestStore.tombstoneExcept:query")),
    );

  const clearRepository: ReviewPullRequestStoreShape["clearRepository"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM review_pull_requests WHERE repository_id = ${input.repositoryId}`;
          yield* sql`DELETE FROM review_pull_request_labels WHERE repository_id = ${input.repositoryId}`;
          yield* sql`DELETE FROM review_pull_request_assignees WHERE repository_id = ${input.repositoryId}`;
          yield* sql`DELETE FROM review_pull_request_review_requests WHERE repository_id = ${input.repositoryId}`;
          yield* sql`DELETE FROM review_sync_state WHERE repository_id = ${input.repositoryId}`;
        }),
      )
      .pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("ReviewPullRequestStore.clearRepository")),
      );

  const getSyncState: ReviewPullRequestStoreShape["getSyncState"] = (input) =>
    sql<SyncStateSqlRow>`
      SELECT
        repository_id AS "repositoryId",
        token_identity AS "tokenIdentity",
        last_seen_updated_at AS "lastSeenUpdatedAt",
        last_synced_at AS "lastSyncedAt",
        full_resynced_at AS "fullResyncedAt",
        last_graphql_cost AS "lastGraphqlCost",
        points_remaining AS "pointsRemaining",
        rate_reset_at AS "rateResetAt"
      FROM review_sync_state
      WHERE repository_id = ${input.repositoryId}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ReviewPullRequestStore.getSyncState:query")),
      Effect.map(
        (rows): Option.Option<ReviewSyncStateRow> =>
          rows[0] ? Option.some(rows[0]) : Option.none(),
      ),
    );

  const upsertSyncState: ReviewPullRequestStoreShape["upsertSyncState"] = (input) =>
    sql`
      INSERT INTO review_sync_state (
        repository_id, token_identity, last_seen_updated_at, last_synced_at,
        full_resynced_at, last_graphql_cost, points_remaining, rate_reset_at
      )
      VALUES (
        ${input.repositoryId}, ${input.tokenIdentity}, ${input.lastSeenUpdatedAt ?? null},
        ${input.lastSyncedAt ?? null}, ${input.fullResyncedAt ?? null},
        ${input.lastGraphqlCost ?? null}, ${input.pointsRemaining ?? null},
        ${input.rateResetAt ?? null}
      )
      ON CONFLICT (repository_id)
      DO UPDATE SET
        token_identity = excluded.token_identity,
        last_seen_updated_at = COALESCE(excluded.last_seen_updated_at, review_sync_state.last_seen_updated_at),
        last_synced_at = COALESCE(excluded.last_synced_at, review_sync_state.last_synced_at),
        full_resynced_at = COALESCE(excluded.full_resynced_at, review_sync_state.full_resynced_at),
        last_graphql_cost = COALESCE(excluded.last_graphql_cost, review_sync_state.last_graphql_cost),
        points_remaining = COALESCE(excluded.points_remaining, review_sync_state.points_remaining),
        rate_reset_at = COALESCE(excluded.rate_reset_at, review_sync_state.rate_reset_at)
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ReviewPullRequestStore.upsertSyncState:query")),
    );

  return {
    upsertPullRequest,
    upsertPullRequests,
    hasOpenPullRequests,
    getLane,
    queryPullRequests,
    getOpenContentHashes,
    tombstoneExcept,
    clearRepository,
    getSyncState,
    upsertSyncState,
  } satisfies ReviewPullRequestStoreShape;
});

export const ReviewPullRequestStoreLive = Layer.effect(
  ReviewPullRequestStore,
  makeReviewPullRequestStore,
);
