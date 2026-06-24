import type {
  ReviewChangesetResult,
  ReviewConversationResult,
  ReviewListPullRequestsResult,
  ReviewPullRequestOverview,
  ReviewWalkthrough,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export interface ReviewCacheEnvelope<T> {
  readonly data: T;
  readonly fetchedAt: number;
  readonly lastValidatedAt: number;
  readonly ttlMs: number;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly tokenIdentity: string;
  readonly headSha: string | null;
}

export interface ReviewCacheWrite<T> {
  readonly repositoryId: string;
  readonly data: T;
  readonly fetchedAt: number;
  readonly ttlMs: number;
  readonly etag?: string | null;
  readonly lastModified?: string | null;
  readonly tokenIdentity: string;
  readonly headSha?: string | null;
}

export interface ReviewCacheListKey {
  readonly repositoryId: string;
  readonly listFilter: string;
}

export interface ReviewCachePullRequestKey {
  readonly repositoryId: string;
  readonly reference: string;
}

export interface ReviewCacheDiffKey extends ReviewCachePullRequestKey {
  readonly headSha: string;
}

export interface ReviewCacheWalkthroughKey extends ReviewCachePullRequestKey {
  readonly patchSignature: string;
}

export interface ReviewCacheStoreShape {
  readonly getPullRequestList: (
    input: ReviewCacheListKey,
  ) => Effect.Effect<
    Option.Option<ReviewCacheEnvelope<ReviewListPullRequestsResult>>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly upsertPullRequestList: (
    input: ReviewCacheWrite<ReviewListPullRequestsResult> & { readonly listFilter: string },
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly getPullRequestOverview: (
    input: ReviewCachePullRequestKey,
  ) => Effect.Effect<
    Option.Option<ReviewCacheEnvelope<ReviewPullRequestOverview>>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly upsertPullRequestOverview: (
    input: ReviewCacheWrite<ReviewPullRequestOverview> & { readonly reference: string },
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly getPullRequestConversation: (
    input: ReviewCachePullRequestKey,
  ) => Effect.Effect<
    Option.Option<ReviewCacheEnvelope<ReviewConversationResult>>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly upsertPullRequestConversation: (
    input: ReviewCacheWrite<ReviewConversationResult> & { readonly reference: string },
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly getPullRequestChangeset: (
    input: ReviewCacheDiffKey,
  ) => Effect.Effect<
    Option.Option<ReviewCacheEnvelope<ReviewChangesetResult>>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly upsertPullRequestChangeset: (
    input: ReviewCacheWrite<ReviewChangesetResult> & {
      readonly reference: string;
      readonly headSha: string;
    },
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly getPullRequestWalkthrough: (
    input: ReviewCacheWalkthroughKey,
  ) => Effect.Effect<
    Option.Option<ReviewWalkthrough>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly upsertPullRequestWalkthrough: (input: {
    readonly repositoryId: string;
    readonly reference: string;
    readonly patchSignature: string;
    readonly data: ReviewWalkthrough;
    readonly fetchedAt: number;
  }) => Effect.Effect<void, PersistenceSqlError>;
}

export class ReviewCacheStore extends ServiceMap.Service<ReviewCacheStore, ReviewCacheStoreShape>()(
  "t3/review/Services/ReviewCacheStore",
) {}
