import { createHash } from "node:crypto";

import {
  ReviewChangesetResult,
  ReviewConversationResult,
  ReviewListPullRequestsResult,
  ReviewPullRequestOverview,
  ReviewWalkthrough,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type PersistenceDecodeError,
  toPersistenceDecodeCauseError,
  toPersistenceSqlError,
} from "../../persistence/Errors.ts";
import {
  ReviewCacheStore,
  type ReviewCacheEnvelope,
  type ReviewCacheStoreShape,
  type ReviewCacheWrite,
} from "../Services/ReviewCacheStore.ts";

interface CacheRow {
  readonly payloadJson: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly fetchedAt: number;
  readonly lastValidatedAt: number;
  readonly ttlMs: number;
  readonly tokenIdentity: string;
  readonly headSha: string | null;
}

const decodeList = Schema.decodeUnknownEffect(ReviewListPullRequestsResult);
const decodeOverview = Schema.decodeUnknownEffect(ReviewPullRequestOverview);
const decodeConversation = Schema.decodeUnknownEffect(ReviewConversationResult);
const decodeChangeset = Schema.decodeUnknownEffect(ReviewChangesetResult);
const decodeWalkthrough = Schema.decodeUnknownEffect(ReviewWalkthrough);
const LIST_CACHE_RETENTION_MS = 24 * 60 * 60 * 1000;
const LIST_CACHE_MAX_ROWS_PER_REPOSITORY = 64;
const DIFF_CACHE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const WALKTHROUGH_CACHE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const WALKTHROUGH_GENERATOR_VERSION = "v1";

function walkthroughSignature(patchSignature: string): string {
  return `${patchSignature}:${WALKTHROUGH_GENERATOR_VERSION}`;
}

function patchSignature(patch: string): string {
  return createHash("sha256").update(patch).digest("hex").slice(0, 16);
}

function normalizeLegacyChangesetPayload(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return input;
  }
  const record = input as Record<string, unknown>;
  const patch = record["patch"];
  if (typeof patch !== "string") {
    return input;
  }
  return {
    ...record,
    patchSignature:
      typeof record["patchSignature"] === "string" && record["patchSignature"].trim().length > 0
        ? record["patchSignature"]
        : patchSignature(patch),
    patchSource:
      record["patchSource"] === "github" ||
      record["patchSource"] === "localFallback" ||
      record["patchSource"] === "localBranchRange"
        ? record["patchSource"]
        : record["pullRequest"] !== undefined
          ? "github"
          : "localBranchRange",
  };
}

const toEnvelope =
  <T>(decode: (input: unknown) => Effect.Effect<T, Schema.SchemaError>) =>
  (row: CacheRow): Effect.Effect<ReviewCacheEnvelope<T>, PersistenceDecodeError> =>
    Effect.try({
      try: () => JSON.parse(row.payloadJson) as unknown,
      catch: toPersistenceDecodeCauseError("ReviewCacheStore.decodeJson"),
    }).pipe(
      Effect.flatMap(decode),
      Effect.map((data) => ({
        data,
        fetchedAt: row.fetchedAt,
        lastValidatedAt: row.lastValidatedAt,
        ttlMs: row.ttlMs,
        etag: row.etag,
        lastModified: row.lastModified,
        tokenIdentity: row.tokenIdentity,
        headSha: row.headSha,
      })),
      Effect.mapError(toPersistenceDecodeCauseError("ReviewCacheStore.decode")),
    );

function validatedAt<T>(input: ReviewCacheWrite<T>): number {
  return input.fetchedAt;
}

const makeReviewCacheStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getPullRequestList: ReviewCacheStoreShape["getPullRequestList"] = (input) =>
    sql<CacheRow>`
      SELECT
        payload_json AS "payloadJson",
        etag,
        last_modified AS "lastModified",
        fetched_at AS "fetchedAt",
        last_validated_at AS "lastValidatedAt",
        ttl_ms AS "ttlMs",
        token_identity AS "tokenIdentity",
        head_sha AS "headSha"
      FROM review_cache_pr_list
      WHERE repository_id = ${input.repositoryId}
        AND list_filter = ${input.listFilter}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ReviewCacheStore.getPullRequestList:query")),
      Effect.flatMap((rows) =>
        rows[0]
          ? toEnvelope(decodeList)(rows[0]).pipe(Effect.map(Option.some))
          : Effect.succeed(Option.none()),
      ),
    );

  const upsertPullRequestList: ReviewCacheStoreShape["upsertPullRequestList"] = (input) =>
    sql`
      INSERT INTO review_cache_pr_list (
        repository_id,
        list_filter,
        payload_json,
        etag,
        last_modified,
        fetched_at,
        last_validated_at,
        ttl_ms,
        token_identity,
        head_sha
      )
      VALUES (
        ${input.repositoryId},
        ${input.listFilter},
        ${JSON.stringify(input.data)},
        ${input.etag ?? null},
        ${input.lastModified ?? null},
        ${input.fetchedAt},
        ${validatedAt(input)},
        ${input.ttlMs},
        ${input.tokenIdentity},
        ${input.headSha ?? null}
      )
      ON CONFLICT (repository_id, list_filter)
      DO UPDATE SET
        payload_json = excluded.payload_json,
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        fetched_at = excluded.fetched_at,
        last_validated_at = excluded.last_validated_at,
        ttl_ms = excluded.ttl_ms,
        token_identity = excluded.token_identity,
        head_sha = excluded.head_sha
    `.pipe(
      Effect.flatMap(
        () => sql`
        DELETE FROM review_cache_pr_list
        WHERE repository_id = ${input.repositoryId}
          AND fetched_at < ${input.fetchedAt - LIST_CACHE_RETENTION_MS}
      `,
      ),
      Effect.flatMap(
        () => sql`
        DELETE FROM review_cache_pr_list
        WHERE repository_id = ${input.repositoryId}
          AND list_filter NOT IN (
            SELECT list_filter
            FROM review_cache_pr_list
            WHERE repository_id = ${input.repositoryId}
            ORDER BY fetched_at DESC, list_filter DESC
            LIMIT ${LIST_CACHE_MAX_ROWS_PER_REPOSITORY}
          )
      `,
      ),
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ReviewCacheStore.upsertPullRequestList:query")),
    );

  const getPullRequestOverview: ReviewCacheStoreShape["getPullRequestOverview"] = (input) =>
    sql<CacheRow>`
      SELECT
        payload_json AS "payloadJson",
        etag,
        last_modified AS "lastModified",
        fetched_at AS "fetchedAt",
        last_validated_at AS "lastValidatedAt",
        ttl_ms AS "ttlMs",
        token_identity AS "tokenIdentity",
        head_sha AS "headSha"
      FROM review_cache_pr_overview
      WHERE repository_id = ${input.repositoryId}
        AND reference = ${input.reference}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ReviewCacheStore.getPullRequestOverview:query")),
      Effect.flatMap((rows) =>
        rows[0]
          ? toEnvelope(decodeOverview)(rows[0]).pipe(Effect.map(Option.some))
          : Effect.succeed(Option.none()),
      ),
    );

  const upsertPullRequestOverview: ReviewCacheStoreShape["upsertPullRequestOverview"] = (input) =>
    sql`
      INSERT INTO review_cache_pr_overview (
        repository_id,
        reference,
        payload_json,
        etag,
        last_modified,
        fetched_at,
        last_validated_at,
        ttl_ms,
        token_identity,
        head_sha
      )
      VALUES (
        ${input.repositoryId},
        ${input.reference},
        ${JSON.stringify(input.data)},
        ${input.etag ?? null},
        ${input.lastModified ?? null},
        ${input.fetchedAt},
        ${validatedAt(input)},
        ${input.ttlMs},
        ${input.tokenIdentity},
        ${input.headSha ?? null}
      )
      ON CONFLICT (repository_id, reference)
      DO UPDATE SET
        payload_json = excluded.payload_json,
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        fetched_at = excluded.fetched_at,
        last_validated_at = excluded.last_validated_at,
        ttl_ms = excluded.ttl_ms,
        token_identity = excluded.token_identity,
        head_sha = excluded.head_sha
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ReviewCacheStore.upsertPullRequestOverview:query")),
    );

  const getPullRequestConversation: ReviewCacheStoreShape["getPullRequestConversation"] = (input) =>
    sql<CacheRow>`
      SELECT
        payload_json AS "payloadJson",
        etag,
        last_modified AS "lastModified",
        fetched_at AS "fetchedAt",
        last_validated_at AS "lastValidatedAt",
        ttl_ms AS "ttlMs",
        token_identity AS "tokenIdentity",
        head_sha AS "headSha"
      FROM review_cache_pr_conversation
      WHERE repository_id = ${input.repositoryId}
        AND reference = ${input.reference}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ReviewCacheStore.getPullRequestConversation:query")),
      Effect.flatMap((rows) =>
        rows[0]
          ? toEnvelope(decodeConversation)(rows[0]).pipe(Effect.map(Option.some))
          : Effect.succeed(Option.none()),
      ),
    );

  const upsertPullRequestConversation: ReviewCacheStoreShape["upsertPullRequestConversation"] = (
    input,
  ) =>
    sql`
      INSERT INTO review_cache_pr_conversation (
        repository_id,
        reference,
        payload_json,
        etag,
        last_modified,
        fetched_at,
        last_validated_at,
        ttl_ms,
        token_identity,
        head_sha
      )
      VALUES (
        ${input.repositoryId},
        ${input.reference},
        ${JSON.stringify(input.data)},
        ${input.etag ?? null},
        ${input.lastModified ?? null},
        ${input.fetchedAt},
        ${validatedAt(input)},
        ${input.ttlMs},
        ${input.tokenIdentity},
        ${input.headSha ?? null}
      )
      ON CONFLICT (repository_id, reference)
      DO UPDATE SET
        payload_json = excluded.payload_json,
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        fetched_at = excluded.fetched_at,
        last_validated_at = excluded.last_validated_at,
        ttl_ms = excluded.ttl_ms,
        token_identity = excluded.token_identity,
        head_sha = excluded.head_sha
    `.pipe(
      Effect.asVoid,
      Effect.mapError(
        toPersistenceSqlError("ReviewCacheStore.upsertPullRequestConversation:query"),
      ),
    );

  const getPullRequestChangeset: ReviewCacheStoreShape["getPullRequestChangeset"] = (input) =>
    sql<CacheRow>`
      SELECT
        payload_json AS "payloadJson",
        etag,
        last_modified AS "lastModified",
        fetched_at AS "fetchedAt",
        last_validated_at AS "lastValidatedAt",
        ttl_ms AS "ttlMs",
        token_identity AS "tokenIdentity",
        head_sha AS "headSha"
      FROM review_cache_pr_diff
      WHERE repository_id = ${input.repositoryId}
        AND reference = ${input.reference}
        AND head_sha = ${input.headSha}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ReviewCacheStore.getPullRequestChangeset:query")),
      Effect.flatMap((rows) =>
        rows[0]
          ? toEnvelope((input) => decodeChangeset(normalizeLegacyChangesetPayload(input)))(
              rows[0],
            ).pipe(Effect.map(Option.some))
          : Effect.succeed(Option.none()),
      ),
    );

  const upsertPullRequestChangeset: ReviewCacheStoreShape["upsertPullRequestChangeset"] = (input) =>
    sql`
      INSERT INTO review_cache_pr_diff (
        repository_id,
        reference,
        head_sha,
        payload_json,
        etag,
        last_modified,
        fetched_at,
        last_validated_at,
        ttl_ms,
        token_identity
      )
      VALUES (
        ${input.repositoryId},
        ${input.reference},
        ${input.headSha},
        ${JSON.stringify(input.data)},
        ${input.etag ?? null},
        ${input.lastModified ?? null},
        ${input.fetchedAt},
        ${validatedAt(input)},
        ${input.ttlMs},
        ${input.tokenIdentity}
      )
      ON CONFLICT (repository_id, reference, head_sha)
      DO UPDATE SET
        payload_json = excluded.payload_json,
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        fetched_at = excluded.fetched_at,
        last_validated_at = excluded.last_validated_at,
        ttl_ms = excluded.ttl_ms,
        token_identity = excluded.token_identity
    `.pipe(
      Effect.flatMap(
        () => sql`
        DELETE FROM review_cache_pr_diff
        WHERE repository_id = ${input.repositoryId}
          AND reference = ${input.reference}
          AND head_sha <> ${input.headSha}
          AND fetched_at < ${input.fetchedAt - DIFF_CACHE_RETENTION_MS}
      `,
      ),
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ReviewCacheStore.upsertPullRequestChangeset:query")),
    );

  const getPullRequestWalkthrough: ReviewCacheStoreShape["getPullRequestWalkthrough"] = (input) =>
    sql<{ readonly payloadJson: string }>`
      SELECT payload_json AS "payloadJson"
      FROM review_cache_pr_walkthrough
      WHERE repository_id = ${input.repositoryId}
        AND reference = ${input.reference}
        AND patch_signature = ${walkthroughSignature(input.patchSignature)}
        AND token_identity = ${input.tokenIdentity}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ReviewCacheStore.getPullRequestWalkthrough:query")),
      Effect.flatMap((rows) => {
        const row = rows[0];
        if (!row) {
          return Effect.succeed(Option.none<ReviewWalkthrough>());
        }
        return Effect.try({
          try: () => JSON.parse(row.payloadJson) as unknown,
          catch: toPersistenceDecodeCauseError("ReviewCacheStore.getPullRequestWalkthrough:json"),
        }).pipe(
          Effect.flatMap(decodeWalkthrough),
          Effect.mapError(
            toPersistenceDecodeCauseError("ReviewCacheStore.getPullRequestWalkthrough:decode"),
          ),
          Effect.map(Option.some),
        );
      }),
    );

  const upsertPullRequestWalkthrough: ReviewCacheStoreShape["upsertPullRequestWalkthrough"] = (
    input,
  ) =>
    sql`
      INSERT INTO review_cache_pr_walkthrough (
        repository_id,
        reference,
        patch_signature,
        token_identity,
        payload_json,
        fetched_at
      )
      VALUES (
        ${input.repositoryId},
        ${input.reference},
        ${walkthroughSignature(input.patchSignature)},
        ${input.tokenIdentity},
        ${JSON.stringify(input.data)},
        ${input.fetchedAt}
      )
      ON CONFLICT (repository_id, reference, patch_signature, token_identity)
      DO UPDATE SET
        payload_json = excluded.payload_json,
        fetched_at = excluded.fetched_at
    `.pipe(
      Effect.flatMap(
        () => sql`
        DELETE FROM review_cache_pr_walkthrough
        WHERE repository_id = ${input.repositoryId}
          AND reference = ${input.reference}
          AND patch_signature <> ${walkthroughSignature(input.patchSignature)}
          AND fetched_at < ${input.fetchedAt - WALKTHROUGH_CACHE_RETENTION_MS}
      `,
      ),
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ReviewCacheStore.upsertPullRequestWalkthrough:query")),
    );

  return {
    getPullRequestList,
    upsertPullRequestList,
    getPullRequestOverview,
    upsertPullRequestOverview,
    getPullRequestConversation,
    upsertPullRequestConversation,
    getPullRequestChangeset,
    upsertPullRequestChangeset,
    getPullRequestWalkthrough,
    upsertPullRequestWalkthrough,
  } satisfies ReviewCacheStoreShape;
});

export const ReviewCacheStoreLive = Layer.effect(ReviewCacheStore, makeReviewCacheStore);
