// Purpose: Constants, raw `gh` JSON Schema shapes, and shared types for the GitHubCli layer.
// Layer: GitHubCliLive (apps/server/src/git/Layers/GitHubCli.ts) — schema/constant module, no runtime logic.
// Exports: timeout/limit constants, PROJECT_SCOPE_MISSING_DETAIL, GraphQL query strings,
//   all Raw*Schema definitions, check-state sets, and PullRequestCoordinates.

import { Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_REVIEW_PULL_REQUEST_LIST_LIMIT = 50;
export const DIFF_TIMEOUT_MS = 120_000;
export const PROJECT_ITEM_LIMIT = 200;

export const PROJECT_SCOPE_MISSING_DETAIL =
  "GitHub CLI token is missing the `read:project` scope. Run `gh auth refresh -s project` and retry.";

export const RawGitHubPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  isCrossRepository: Schema.optional(Schema.Boolean),
  headRepository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nameWithOwner: Schema.String,
      }),
    ),
  ),
  headRepositoryOwner: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.String,
      }),
    ),
  ),
});

export const RawGitHubRepositoryCloneUrlsSchema = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});

export const RawStatusCheckRollupEntrySchema = Schema.Struct({
  __typename: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  context: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  workflowName: Schema.optional(Schema.NullOr(Schema.String)),
  detailsUrl: Schema.optional(Schema.NullOr(Schema.String)),
  targetUrl: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  startedAt: Schema.optional(Schema.NullOr(Schema.String)),
  completedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

export const RawReviewRequestSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  slug: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

export const RawReviewAuthorSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawReviewRequestedReviewerSchema = Schema.Struct({
  __typename: Schema.optional(Schema.NullOr(Schema.String)),
  login: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  slug: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawReviewRequestNodeSchema = Schema.Struct({
  requestedReviewer: Schema.optional(Schema.NullOr(RawReviewRequestedReviewerSchema)),
});

const RawReviewLatestReviewNodeSchema = Schema.Struct({
  author: Schema.optional(Schema.NullOr(RawReviewAuthorSchema)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawReviewRequestConnectionSchema = Schema.Struct({
  nodes: Schema.optional(Schema.NullOr(Schema.Array(RawReviewRequestNodeSchema))),
});

const RawReviewLatestReviewConnectionSchema = Schema.Struct({
  nodes: Schema.optional(Schema.NullOr(Schema.Array(RawReviewLatestReviewNodeSchema))),
});

export const RawReviewAvatarEnrichmentResponseSchema = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              pullRequest: Schema.optional(
                Schema.NullOr(
                  Schema.Struct({
                    reviewRequests: Schema.optional(
                      Schema.NullOr(RawReviewRequestConnectionSchema),
                    ),
                    latestReviews: Schema.optional(
                      Schema.NullOr(RawReviewLatestReviewConnectionSchema),
                    ),
                  }),
                ),
              ),
            }),
          ),
        ),
      }),
    ),
  ),
});

export const RawReviewLabelSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  color: Schema.optional(Schema.NullOr(Schema.String)),
});

export const RawReviewUserSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

export const RawGitHubReviewPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  url: Schema.String,
  baseRefName: Schema.String,
  headRefName: Schema.String,
  headRepositoryOwner: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.String,
      }),
    ),
  ),
  author: Schema.optional(Schema.NullOr(RawReviewAuthorSchema)),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.Boolean),
  additions: Schema.optional(Schema.NullOr(Schema.Number)),
  deletions: Schema.optional(Schema.NullOr(Schema.Number)),
  statusCheckRollup: Schema.optional(Schema.NullOr(Schema.Array(RawStatusCheckRollupEntrySchema))),
  reviewRequests: Schema.optional(Schema.NullOr(Schema.Array(RawReviewRequestSchema))),
  labels: Schema.optional(Schema.NullOr(Schema.Array(RawReviewLabelSchema))),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(RawReviewUserSchema))),
});

export const FAILING_CHECK_STATES = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

export const PENDING_CHECK_STATES = new Set([
  "PENDING",
  "IN_PROGRESS",
  "QUEUED",
  "EXPECTED",
  "WAITING",
]);

export const SUCCESS_CHECK_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

export const RawReviewCommitAuthorSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

export const RawReviewCommitSchema = Schema.Struct({
  oid: Schema.String,
  messageHeadline: Schema.optional(Schema.NullOr(Schema.String)),
  messageBody: Schema.optional(Schema.NullOr(Schema.String)),
  authoredDate: Schema.optional(Schema.NullOr(Schema.String)),
  committedDate: Schema.optional(Schema.NullOr(Schema.String)),
  authors: Schema.optional(Schema.NullOr(Schema.Array(RawReviewCommitAuthorSchema))),
});

export const RawReviewLatestReviewSchema = Schema.Struct({
  author: Schema.optional(Schema.NullOr(RawReviewAuthorSchema)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
});

export const RawReviewMilestoneSchema = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
});

export const RawGitHubReviewDetailSchema = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  url: Schema.String,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.Boolean),
  author: Schema.optional(Schema.NullOr(RawReviewAuthorSchema)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  baseRefName: Schema.String,
  headRefName: Schema.String,
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  additions: Schema.optional(Schema.NullOr(Schema.Number)),
  deletions: Schema.optional(Schema.NullOr(Schema.Number)),
  changedFiles: Schema.optional(Schema.NullOr(Schema.Number)),
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  mergeable: Schema.optional(Schema.NullOr(Schema.String)),
  mergeStateStatus: Schema.optional(Schema.NullOr(Schema.String)),
  milestone: Schema.optional(Schema.NullOr(RawReviewMilestoneSchema)),
  labels: Schema.optional(Schema.NullOr(Schema.Array(RawReviewLabelSchema))),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(RawReviewUserSchema))),
  reviewRequests: Schema.optional(Schema.NullOr(Schema.Array(RawReviewRequestSchema))),
  latestReviews: Schema.optional(Schema.NullOr(Schema.Array(RawReviewLatestReviewSchema))),
  commits: Schema.optional(Schema.NullOr(Schema.Array(RawReviewCommitSchema))),
  statusCheckRollup: Schema.optional(Schema.NullOr(Schema.Array(RawStatusCheckRollupEntrySchema))),
});

export const GRAPHQL_REVIEW_AVATARS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewRequests(first: 100) {
        nodes {
          requestedReviewer {
            __typename
            ... on User { login avatarUrl }
            ... on Team { name slug avatarUrl }
          }
        }
      }
      latestReviews(first: 100) {
        nodes {
          author { login avatarUrl }
          state
        }
      }
    }
  }
}`;

export const RawConversationCommentSchema = Schema.Struct({
  author: Schema.optional(Schema.NullOr(RawReviewAuthorSchema)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

export const RawConversationReviewSchema = Schema.Struct({
  author: Schema.optional(Schema.NullOr(RawReviewAuthorSchema)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  submittedAt: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

export const RawGitHubConversationSchema = Schema.Struct({
  comments: Schema.optional(Schema.NullOr(Schema.Array(RawConversationCommentSchema))),
  reviews: Schema.optional(Schema.NullOr(Schema.Array(RawConversationReviewSchema))),
  commits: Schema.optional(Schema.NullOr(Schema.Array(RawReviewCommitSchema))),
});

export const RawCreateReviewResponseSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Number)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
});

export const GRAPHQL_REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $threadsCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $threadsCursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          path
          line
          diffSide
          comments(first: 100) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              author { login avatarUrl }
              body
              createdAt
              url
            }
          }
        }
      }
    }
  }
}`;

export const GRAPHQL_REVIEW_THREAD_COMMENTS_QUERY = `query($threadId: ID!, $commentsCursor: String) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $commentsCursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          author { login avatarUrl }
          body
          createdAt
          url
        }
      }
    }
  }
}`;

export const RawPageInfoSchema = Schema.Struct({
  hasNextPage: Schema.optional(Schema.NullOr(Schema.Boolean)),
  endCursor: Schema.optional(Schema.NullOr(Schema.String)),
});

export const RawReviewThreadCommentSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.optional(Schema.String),
        avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

export const RawReviewThreadSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  isResolved: Schema.optional(Schema.NullOr(Schema.Boolean)),
  path: Schema.optional(Schema.NullOr(Schema.String)),
  line: Schema.optional(Schema.NullOr(Schema.Number)),
  diffSide: Schema.optional(Schema.NullOr(Schema.String)),
  comments: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        pageInfo: Schema.optional(Schema.NullOr(RawPageInfoSchema)),
        nodes: Schema.Array(RawReviewThreadCommentSchema),
      }),
    ),
  ),
});

export const RawReviewThreadsResponseSchema = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              pullRequest: Schema.optional(
                Schema.NullOr(
                  Schema.Struct({
                    reviewThreads: Schema.Struct({
                      pageInfo: Schema.optional(Schema.NullOr(RawPageInfoSchema)),
                      nodes: Schema.Array(RawReviewThreadSchema),
                    }),
                  }),
                ),
              ),
            }),
          ),
        ),
      }),
    ),
  ),
});

export const RawReviewThreadCommentsResponseSchema = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        node: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              comments: Schema.Struct({
                pageInfo: Schema.optional(Schema.NullOr(RawPageInfoSchema)),
                nodes: Schema.Array(RawReviewThreadCommentSchema),
              }),
            }),
          ),
        ),
      }),
    ),
  ),
});

export const RawProjectSummarySchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  number: PositiveInt,
  title: Schema.String,
  url: Schema.optional(Schema.NullOr(Schema.String)),
  owner: Schema.optional(
    Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

export const RawProjectListSchema = Schema.Struct({
  projects: Schema.optional(Schema.NullOr(Schema.Array(RawProjectSummarySchema))),
});

export const RawProjectFieldSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  type: Schema.optional(Schema.NullOr(Schema.String)),
  options: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Struct({ id: TrimmedNonEmptyString, name: Schema.String }))),
  ),
});

export const RawProjectFieldListSchema = Schema.Struct({
  fields: Schema.optional(Schema.NullOr(Schema.Array(RawProjectFieldSchema))),
});

export const RawProjectItemListSchema = Schema.Struct({
  items: Schema.optional(Schema.NullOr(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)))),
});

export const RawProjectItemContentSchema = Schema.Struct({
  type: Schema.optional(Schema.NullOr(Schema.String)),
  number: Schema.optional(Schema.NullOr(Schema.Number)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  repository: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.String) }))),
  assignees: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Struct({ login: Schema.optional(Schema.String) }))),
  ),
});

export interface PullRequestCoordinates {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}
