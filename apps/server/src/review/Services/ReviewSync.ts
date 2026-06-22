import type { ReviewPullRequestSummary } from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export class ReviewSyncError extends Schema.TaggedErrorClass<ReviewSyncError>()("ReviewSyncError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
  // Set when GitHub rejected the call for exceeding the rate limit; `resetAt` is the
  // epoch-ms the window reopens when parseable from the error, else undefined.
  rateLimited: Schema.optional(Schema.Boolean),
  resetAt: Schema.optional(Schema.Number),
}) {
  override get message(): string {
    return `Review sync error in ${this.operation}: ${this.detail}`;
  }
}

/** GraphQL `rateLimit { cost remaining resetAt }`, reported on every page. */
export interface ReviewRemoteBudget {
  readonly cost: number;
  readonly remaining: number;
  readonly resetAt: number;
}

export interface ReviewRemotePage {
  readonly pullRequests: ReadonlyArray<ReviewPullRequestSummary>;
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
  readonly budget: ReviewRemoteBudget;
}

/** Pages a repo's PRs newest-updated-first; backed by `gh api graphql` in prod. */
export interface ReviewRemoteSourceShape {
  readonly fetchUpdatedPage: (input: {
    readonly cwd: string;
    readonly after: string | null;
    readonly pageSize: number;
  }) => Effect.Effect<ReviewRemotePage, ReviewSyncError>;
}

export class ReviewRemoteSource extends ServiceMap.Service<
  ReviewRemoteSource,
  ReviewRemoteSourceShape
>()("t3/review/Services/ReviewRemoteSource") {}

export type ReviewSyncStopReason =
  | "watermark"
  | "end"
  | "budget"
  | "pre-budget-floor"
  | "rate-limited";

export interface ReviewSyncResult {
  readonly upserted: number;
  readonly skippedUnchanged: number;
  readonly pagesFetched: number;
  readonly reconciled: boolean;
  readonly stopReason: ReviewSyncStopReason;
  readonly pointsRemaining: number | null;
}

export interface ReviewSyncRequest {
  readonly cwd: string;
  readonly repositoryId: string;
  readonly tokenIdentity: string;
  readonly now: number;
  /** "delta" stops at the watermark; "full" scans everything and reconciles tombstones. */
  readonly mode?: "delta" | "full";
}

export interface ReviewSyncShape {
  readonly syncRepository: (
    input: ReviewSyncRequest,
  ) => Effect.Effect<
    ReviewSyncResult,
    ReviewSyncError | PersistenceSqlError | PersistenceDecodeError
  >;
}

export class ReviewSync extends ServiceMap.Service<ReviewSync, ReviewSyncShape>()(
  "t3/review/Services/ReviewSync",
) {}

/** Stop scheduling syncs while remaining points sit below this and the window has not reset. */
export const REVIEW_SYNC_RESERVE_FLOOR = 1_000;
export const REVIEW_SYNC_PAGE_SIZE = 100;

/** Backoff applied when GitHub reports the limit already exceeded and gives no parseable reset. */
export const REVIEW_SYNC_RATE_LIMIT_COOLDOWN_MS = 900_000;
