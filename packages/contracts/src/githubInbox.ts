import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import {
  GitHubViewerInvolvement,
  PullRequestActor,
  PullRequestComment,
  PullRequestDetailInput,
  PullRequestLabel,
  PullRequestListEntry,
  PullRequestProjectContext,
} from "./pullRequests";

// The inbox lists pull requests and issues for the GitHub repositories of the projects added in
// Synara. Detail, diff, actions, comments, and pins for pull requests stay in `pullRequests.ts`.
//
// Pins: `pullRequests.setPinned` pins issues too. GitHub numbers pull requests and issues from one
// sequence per repository, so (project, repository, number) identifies either kind and the pin
// table needs no kind column.

export const GitHubInboxItemKind = Schema.Literals(["pullRequest", "issue"]);
export type GitHubInboxItemKind = typeof GitHubInboxItemKind.Type;

/** Open, or closed including merged pull requests. */
export const GitHubInboxState = Schema.Literals(["open", "closed"]);
export type GitHubInboxState = typeof GitHubInboxState.Type;

export const GitHubInboxSort = Schema.Literals(["created", "updated"]);
export type GitHubInboxSort = typeof GitHubInboxSort.Type;

export const GitHubIssueState = Schema.Literals(["open", "closed"]);
export type GitHubIssueState = typeof GitHubIssueState.Type;

/** Why a closed issue was closed. Null for open issues and for issues closed without a reason. */
export const GitHubIssueStateReason = Schema.Literals(["completed", "not-planned", "duplicate"]);
export type GitHubIssueStateReason = typeof GitHubIssueStateReason.Type;

export const GitHubIssueListEntry = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  projectContexts: Schema.Array(PullRequestProjectContext),
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  state: GitHubIssueState,
  stateReason: Schema.NullOr(GitHubIssueStateReason),
  labels: Schema.Array(PullRequestLabel),
  assignees: Schema.Array(PullRequestActor),
  commentCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
  isPinned: Schema.Boolean,
  viewerInvolvement: GitHubViewerInvolvement,
});
export type GitHubIssueListEntry = typeof GitHubIssueListEntry.Type;

export const GitHubInboxPullRequestItem = Schema.Struct({
  kind: Schema.Literal("pullRequest"),
  ...PullRequestListEntry.fields,
});
export type GitHubInboxPullRequestItem = typeof GitHubInboxPullRequestItem.Type;

export const GitHubInboxIssueItem = Schema.Struct({
  kind: Schema.Literal("issue"),
  ...GitHubIssueListEntry.fields,
});
export type GitHubInboxIssueItem = typeof GitHubInboxIssueItem.Type;

export const GitHubInboxItem = Schema.Union([GitHubInboxPullRequestItem, GitHubInboxIssueItem]);
export type GitHubInboxItem = typeof GitHubInboxItem.Type;

/**
 * One superset per state and sort. Project, kind, involvement, label, and text filters are applied by the
 * client, so switching them never reaches GitHub.
 */
export const GitHubInboxListInput = Schema.Struct({
  state: GitHubInboxState,
  /** Omitted by older clients, which use the last-updated order. */
  sort: Schema.optional(GitHubInboxSort),
  forceRefresh: Schema.optional(Schema.Boolean),
});
export type GitHubInboxListInput = typeof GitHubInboxListInput.Type;

export const GitHubInboxListErrorReason = Schema.Literals(["unavailable", "rate-limited"]);
export type GitHubInboxListErrorReason = typeof GitHubInboxListErrorReason.Type;

/**
 * A project or repository whose items are missing or stale. `repository` is null when the
 * project's repository inventory could not be read. `showingCachedData` means the repository's
 * last good snapshot is still in `items`, so the note is a warning rather than a gap.
 */
export const GitHubInboxListError = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  repository: Schema.NullOr(TrimmedNonEmptyString),
  message: TrimmedNonEmptyString,
  reason: GitHubInboxListErrorReason,
  retryAt: Schema.NullOr(IsoDateTime),
  showingCachedData: Schema.Boolean,
});
export type GitHubInboxListError = typeof GitHubInboxListError.Type;

export const GitHubInboxRepositoryBatch = Schema.Struct({
  repository: TrimmedNonEmptyString,
  projectIds: Schema.Array(ProjectId),
  truncatedPullRequests: Schema.Boolean,
  truncatedIssues: Schema.Boolean,
  /** How many pull requests and issues the repository has in the listed state, which can be more
   *  than the rows returned. Absent from servers that predate the fields. */
  totalPullRequests: Schema.optional(Schema.Number),
  totalIssues: Schema.optional(Schema.Number),
  fetchedAt: IsoDateTime,
});
export type GitHubInboxRepositoryBatch = typeof GitHubInboxRepositoryBatch.Type;

/** Latest GitHub GraphQL budget seen by the server. */
export const GitHubInboxRateLimit = Schema.Struct({
  remaining: NonNegativeInt,
  resetAt: IsoDateTime,
});
export type GitHubInboxRateLimit = typeof GitHubInboxRateLimit.Type;

export const GitHubInboxListResult = Schema.Struct({
  viewer: Schema.NullOr(TrimmedNonEmptyString),
  items: Schema.Array(GitHubInboxItem),
  errors: Schema.Array(GitHubInboxListError),
  repositoryBatches: Schema.Array(GitHubInboxRepositoryBatch),
  rateLimit: Schema.NullOr(GitHubInboxRateLimit),
  /** Open pull requests awaiting the viewer's review, including team requests. Zero for closed. */
  reviewRequestedCount: NonNegativeInt,
  /** True when a repository could not be counted, so the count is a lower bound. */
  reviewRequestedCountIncomplete: Schema.Boolean,
});
export type GitHubInboxListResult = typeof GitHubInboxListResult.Type;

export const GitHubIssueDetailInput = PullRequestDetailInput;
export type GitHubIssueDetailInput = typeof GitHubIssueDetailInput.Type;

export const GitHubIssueDetail = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  state: GitHubIssueState,
  stateReason: Schema.NullOr(GitHubIssueStateReason),
  labels: Schema.Array(PullRequestLabel),
  assignees: Schema.Array(PullRequestActor),
  commentCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
  body: Schema.String,
  /** Issue comments, oldest first, with kind `issue-comment`. */
  comments: Schema.Array(PullRequestComment),
  commentsTruncated: Schema.Boolean,
});
export type GitHubIssueDetail = typeof GitHubIssueDetail.Type;

export const GitHubIssueCommentInput = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  // GitHub rejects comment bodies past 65536 characters, as for pull request comments.
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(65536)),
});
export type GitHubIssueCommentInput = typeof GitHubIssueCommentInput.Type;

export const GitHubIssueCommentResult = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  workspaceRoot: TrimmedNonEmptyString,
});
export type GitHubIssueCommentResult = typeof GitHubIssueCommentResult.Type;
