import type { ReviewPullRequestSummary } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export interface ReviewPullRequestUpsert {
  readonly repositoryId: string;
  readonly tokenIdentity: string;
  readonly syncedAt: number;
  readonly lane: string;
  readonly contentHash: string;
  readonly summary: ReviewPullRequestSummary;
}

export interface ReviewLaneQuery {
  readonly repositoryId: string;
  readonly lane: string;
  readonly limit: number;
}

export interface ReviewPullRequestQuery {
  readonly repositoryId: string;
  readonly state: "open" | "merged" | "closed" | "all";
  readonly lanes?: ReadonlyArray<string>;
  readonly authors?: ReadonlyArray<string>;
  readonly baseBranches?: ReadonlyArray<string>;
  readonly headBranches?: ReadonlyArray<string>;
  readonly labels?: ReadonlyArray<string>;
  readonly assignees?: ReadonlyArray<string>;
  readonly reviewRequested?: string;
  readonly draft?: boolean;
  readonly sort: "updated" | "size";
  readonly limit: number;
}

export interface ReviewSyncStateRow {
  readonly repositoryId: string;
  readonly tokenIdentity: string;
  readonly lastSeenUpdatedAt: string | null;
  readonly lastSyncedAt: number | null;
  readonly fullResyncedAt: number | null;
  readonly lastGraphqlCost: number | null;
  readonly pointsRemaining: number | null;
  readonly rateResetAt: number | null;
}

export interface ReviewSyncStateWrite {
  readonly repositoryId: string;
  readonly tokenIdentity: string;
  readonly lastSeenUpdatedAt?: string | null;
  readonly lastSyncedAt?: number | null;
  readonly fullResyncedAt?: number | null;
  readonly lastGraphqlCost?: number | null;
  readonly pointsRemaining?: number | null;
  readonly rateResetAt?: number | null;
}

export interface ReviewPullRequestStoreShape {
  /** Upsert one PR row plus its label/assignee child rows, atomically. */
  readonly upsertPullRequest: (
    input: ReviewPullRequestUpsert,
  ) => Effect.Effect<void, PersistenceSqlError>;
  /** Upsert many PRs in a single transaction (one round trip per sync page). */
  readonly upsertPullRequests: (
    input: ReadonlyArray<ReviewPullRequestUpsert>,
  ) => Effect.Effect<void, PersistenceSqlError>;
  /** Cheap EXISTS check for open, non-tombstoned rows; drives cold-start detection. */
  readonly hasOpenPullRequests: (input: {
    readonly repositoryId: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  /** Open, non-tombstoned PRs in a lane, newest first, decoded from summary_json. */
  readonly getLane: (
    input: ReviewLaneQuery,
  ) => Effect.Effect<
    ReadonlyArray<ReviewPullRequestSummary>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  /** Filtered PR query over the mirror (state, lanes, author/base/head, labels, assignees, draft, sort). */
  readonly queryPullRequests: (
    input: ReviewPullRequestQuery,
  ) => Effect.Effect<
    ReadonlyArray<ReviewPullRequestSummary>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  /** number -> content_hash for open, non-tombstoned rows; drives skip-unchanged + reconcile. */
  readonly getOpenContentHashes: (input: {
    readonly repositoryId: string;
  }) => Effect.Effect<ReadonlyMap<number, string>, PersistenceSqlError>;
  /** Tombstone open rows whose number is not in keepNumbers (closed/merged elsewhere). */
  readonly tombstoneExcept: (input: {
    readonly repositoryId: string;
    readonly keepNumbers: ReadonlyArray<number>;
    readonly at: number;
  }) => Effect.Effect<void, PersistenceSqlError>;
  /** Drop all rows for a repository (token-identity change / full reset). */
  readonly clearRepository: (input: {
    readonly repositoryId: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
  readonly getSyncState: (input: {
    readonly repositoryId: string;
  }) => Effect.Effect<Option.Option<ReviewSyncStateRow>, PersistenceSqlError>;
  readonly upsertSyncState: (
    input: ReviewSyncStateWrite,
  ) => Effect.Effect<void, PersistenceSqlError>;
}

export class ReviewPullRequestStore extends ServiceMap.Service<
  ReviewPullRequestStore,
  ReviewPullRequestStoreShape
>()("t3/review/Services/ReviewPullRequestStore") {}
