import { Option, Schema } from "effect";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";
import { GitResolvedPullRequest } from "./git";
import { DEFAULT_GIT_TEXT_GENERATION_MODEL } from "./model";
import { ModelSelection, ProviderStartOptions } from "./orchestration";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const ReviewPullRequestReference = TrimmedNonEmptyStringSchema;
const GitPullRequestReference = TrimmedNonEmptyStringSchema;
const ReviewRepositoryId = TrimmedNonEmptyStringSchema;
const ReviewPullRequestState = Schema.Literals(["open", "closed", "merged"]);
const ReviewListState = Schema.Literals(["open", "closed", "merged", "all"]);
const ReviewListColumn = Schema.Literals([
  "draft",
  "needs-review",
  "changes-requested",
  "approved",
  "merged",
]);
const ReviewChecksStatus = Schema.Literals(["passing", "failing", "pending", "none"]);
const ReviewListSort = Schema.Literals(["updated", "title", "size"]);
export type ReviewListSort = typeof ReviewListSort.Type;

export const ReviewSourceRef = Schema.Union([
  Schema.TaggedStruct("pullRequest", {
    reference: ReviewPullRequestReference,
  }),
  Schema.TaggedStruct("branchRange", {
    base: TrimmedNonEmptyStringSchema,
    head: TrimmedNonEmptyStringSchema,
  }),
]);
export type ReviewSourceRef = typeof ReviewSourceRef.Type;

export const ReviewTargetKey = Schema.Union([
  Schema.TaggedStruct("pullRequest", {
    repositoryId: ReviewRepositoryId,
    number: PositiveInt,
  }),
  Schema.TaggedStruct("branchRange", {
    repositoryId: ReviewRepositoryId,
    base: TrimmedNonEmptyStringSchema,
    head: TrimmedNonEmptyStringSchema,
  }),
]);
export type ReviewTargetKey = typeof ReviewTargetKey.Type;

export const ReviewPullRequestSummary = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  headSelector: Schema.optional(TrimmedNonEmptyStringSchema),
  author: Schema.String,
  authorAvatarUrl: Schema.optional(Schema.String),
  updatedAt: Schema.String,
  state: ReviewPullRequestState,
  reviewDecision: Schema.NullOr(Schema.String),
  isDraft: Schema.Boolean,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  checksStatus: ReviewChecksStatus,
  reviewRequests: Schema.Array(Schema.String),
  labels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
  assignees: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type ReviewPullRequestSummary = typeof ReviewPullRequestSummary.Type;

export const ReviewChangedFile = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
  status: Schema.optional(Schema.String),
});
export type ReviewChangedFile = typeof ReviewChangedFile.Type;

export const ReviewListPullRequestsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  state: Schema.optional(ReviewListState).pipe(
    Schema.withConstructorDefault(() => Option.some("open" as const)),
  ),
  limit: Schema.optional(PositiveInt),
  search: Schema.optional(TrimmedNonEmptyStringSchema),
  author: Schema.optional(TrimmedNonEmptyStringSchema),
  authors: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
  reviewRequested: Schema.optional(TrimmedNonEmptyStringSchema),
  baseBranch: Schema.optional(TrimmedNonEmptyStringSchema),
  baseBranches: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
  headBranch: Schema.optional(TrimmedNonEmptyStringSchema),
  headBranches: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
  label: Schema.optional(TrimmedNonEmptyStringSchema),
  labels: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
  assignee: Schema.optional(TrimmedNonEmptyStringSchema),
  assignees: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
  draft: Schema.optional(Schema.Boolean),
  columns: Schema.optional(Schema.Array(ReviewListColumn)),
  checks: Schema.optional(Schema.Array(ReviewChecksStatus)),
  sort: Schema.optional(ReviewListSort),
});
export type ReviewListPullRequestsInput = typeof ReviewListPullRequestsInput.Type;

export const ReviewListPullRequestsResult = Schema.Struct({
  pullRequests: Schema.Array(ReviewPullRequestSummary),
  meta: Schema.optional(
    Schema.Struct({
      requestedLimit: Schema.optional(PositiveInt),
      resultLimit: PositiveInt,
      candidateLimit: PositiveInt,
      candidateCount: NonNegativeInt,
      candidateLimitReached: Schema.Boolean,
      matchedCount: NonNegativeInt,
      returnedCount: NonNegativeInt,
      bounded: Schema.Boolean,
    }),
  ),
});
export type ReviewListPullRequestsResult = typeof ReviewListPullRequestsResult.Type;

export const ReviewLoadBoardLanesInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  limit: Schema.optional(PositiveInt),
});
export type ReviewLoadBoardLanesInput = typeof ReviewLoadBoardLanesInput.Type;

export const ReviewBoardLanesResult = Schema.Struct({
  "needs-review": ReviewListPullRequestsResult,
  "changes-requested": ReviewListPullRequestsResult,
  approved: ReviewListPullRequestsResult,
  draft: ReviewListPullRequestsResult,
});
export type ReviewBoardLanesResult = typeof ReviewBoardLanesResult.Type;

export const ReviewGetViewerInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type ReviewGetViewerInput = typeof ReviewGetViewerInput.Type;

export const ReviewViewerResult = Schema.Struct({
  login: Schema.String,
  avatarUrl: Schema.optional(Schema.String),
});
export type ReviewViewerResult = typeof ReviewViewerResult.Type;

export const ReviewLoadChangesetInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  source: ReviewSourceRef,
});
export type ReviewLoadChangesetInput = typeof ReviewLoadChangesetInput.Type;

export const ReviewChangesetResult = Schema.Struct({
  target: ReviewTargetKey,
  patch: Schema.String,
  patchSignature: Schema.optional(TrimmedNonEmptyStringSchema),
  patchSource: Schema.optional(Schema.Literals(["github", "localFallback", "localBranchRange"])),
  files: Schema.Array(ReviewChangedFile),
  pullRequest: Schema.optional(GitResolvedPullRequest),
  headSha: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ReviewChangesetResult = typeof ReviewChangesetResult.Type;

export const ReviewCommentSide = Schema.Literals(["LEFT", "RIGHT"]);
export type ReviewCommentSide = typeof ReviewCommentSide.Type;

export const ReviewLocalComment = Schema.Struct({
  id: TrimmedNonEmptyStringSchema,
  threadId: TrimmedNonEmptyStringSchema,
  path: TrimmedNonEmptyStringSchema,
  line: PositiveInt,
  side: ReviewCommentSide,
  body: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(10_000)),
  resolved: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ReviewLocalComment = typeof ReviewLocalComment.Type;

export const ReviewCommentList = Schema.Struct({
  target: ReviewTargetKey,
  comments: Schema.Array(ReviewLocalComment),
});
export type ReviewCommentList = typeof ReviewCommentList.Type;

export const ReviewListCommentsInput = Schema.Struct({
  target: ReviewTargetKey,
});
export type ReviewListCommentsInput = typeof ReviewListCommentsInput.Type;

export const ReviewAddCommentInput = Schema.Struct({
  target: ReviewTargetKey,
  path: TrimmedNonEmptyStringSchema,
  line: PositiveInt,
  side: ReviewCommentSide,
  body: TrimmedNonEmptyStringSchema,
  threadId: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ReviewAddCommentInput = typeof ReviewAddCommentInput.Type;

export const ReviewUpdateCommentInput = Schema.Struct({
  target: ReviewTargetKey,
  id: TrimmedNonEmptyStringSchema,
  body: Schema.optional(TrimmedNonEmptyStringSchema),
  resolved: Schema.optional(Schema.Boolean),
});
export type ReviewUpdateCommentInput = typeof ReviewUpdateCommentInput.Type;

export const ReviewRemoveCommentInput = Schema.Struct({
  target: ReviewTargetKey,
  id: TrimmedNonEmptyStringSchema,
});
export type ReviewRemoveCommentInput = typeof ReviewRemoveCommentInput.Type;

export const ReviewRemoveCommentResult = Schema.Struct({
  removed: Schema.Boolean,
});
export type ReviewRemoveCommentResult = typeof ReviewRemoveCommentResult.Type;

export const ReviewSubmitEvent = Schema.Literals(["approve", "request_changes", "comment"]);
export type ReviewSubmitEvent = typeof ReviewSubmitEvent.Type;

export const ReviewInlineComment = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  line: PositiveInt,
  side: ReviewCommentSide,
  body: TrimmedNonEmptyStringSchema,
});
export type ReviewInlineComment = typeof ReviewInlineComment.Type;

export const ReviewSubmitInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
  event: ReviewSubmitEvent,
  body: Schema.optional(TrimmedNonEmptyStringSchema),
  comments: Schema.optional(Schema.Array(ReviewInlineComment)),
  expectedHeadSha: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ReviewSubmitInput = typeof ReviewSubmitInput.Type;

export const ReviewSubmitResult = Schema.Struct({
  submitted: Schema.Boolean,
  url: Schema.optional(Schema.String),
  reviewId: Schema.optional(PositiveInt),
  skippedComments: Schema.optional(Schema.Array(ReviewInlineComment)),
  headMoved: Schema.optional(Schema.Boolean),
});
export type ReviewSubmitResult = typeof ReviewSubmitResult.Type;

export const ReviewRemoteThreadComment = Schema.Struct({
  id: Schema.optional(TrimmedNonEmptyStringSchema),
  author: Schema.String,
  authorAvatarUrl: Schema.optional(Schema.String),
  body: Schema.String,
  createdAt: Schema.String,
  url: Schema.optional(Schema.String),
});
export type ReviewRemoteThreadComment = typeof ReviewRemoteThreadComment.Type;

export const ReviewRemoteThread = Schema.Struct({
  id: TrimmedNonEmptyStringSchema,
  path: Schema.optional(TrimmedNonEmptyStringSchema),
  line: Schema.optional(PositiveInt),
  side: Schema.optional(ReviewCommentSide),
  isResolved: Schema.Boolean,
  comments: Schema.Array(ReviewRemoteThreadComment),
});
export type ReviewRemoteThread = typeof ReviewRemoteThread.Type;

export const ReviewLoadRemoteThreadsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
});
export type ReviewLoadRemoteThreadsInput = typeof ReviewLoadRemoteThreadsInput.Type;

export const ReviewRemoteThreadsResult = Schema.Struct({
  threads: Schema.Array(ReviewRemoteThread),
});
export type ReviewRemoteThreadsResult = typeof ReviewRemoteThreadsResult.Type;

export const ReviewResolveThreadInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
  threadId: TrimmedNonEmptyStringSchema,
  resolved: Schema.Boolean,
});
export type ReviewResolveThreadInput = typeof ReviewResolveThreadInput.Type;

export const ReviewResolveThreadResult = Schema.Struct({
  threadId: TrimmedNonEmptyStringSchema,
  isResolved: Schema.Boolean,
});
export type ReviewResolveThreadResult = typeof ReviewResolveThreadResult.Type;

export const ReviewReplyThreadInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
  threadId: TrimmedNonEmptyStringSchema,
  body: TrimmedNonEmptyStringSchema,
});
export type ReviewReplyThreadInput = typeof ReviewReplyThreadInput.Type;

export const ReviewReplyThreadResult = Schema.Struct({
  threadId: TrimmedNonEmptyStringSchema,
});
export type ReviewReplyThreadResult = typeof ReviewReplyThreadResult.Type;

export const ReviewUpdateThreadCommentInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
  commentId: TrimmedNonEmptyStringSchema,
  body: TrimmedNonEmptyStringSchema,
});
export type ReviewUpdateThreadCommentInput = typeof ReviewUpdateThreadCommentInput.Type;

export const ReviewDeleteThreadCommentInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
  commentId: TrimmedNonEmptyStringSchema,
});
export type ReviewDeleteThreadCommentInput = typeof ReviewDeleteThreadCommentInput.Type;

export const ReviewThreadCommentMutationResult = Schema.Struct({
  commentId: TrimmedNonEmptyStringSchema,
});
export type ReviewThreadCommentMutationResult = typeof ReviewThreadCommentMutationResult.Type;

export const ReviewFindingSeverity = Schema.Literals(["blocker", "major", "minor", "nit"]);
export type ReviewFindingSeverity = typeof ReviewFindingSeverity.Type;

export const ReviewFinding = Schema.Struct({
  id: Schema.optional(TrimmedNonEmptyStringSchema),
  path: TrimmedNonEmptyStringSchema,
  line: PositiveInt,
  side: ReviewCommentSide,
  severity: ReviewFindingSeverity,
  title: TrimmedNonEmptyStringSchema,
  message: TrimmedNonEmptyStringSchema,
});
export type ReviewFinding = typeof ReviewFinding.Type;

// Agent review reuses the shared git text-generation model settings.
export const ReviewRunAgentInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  source: ReviewSourceRef,
  codexHomePath: Schema.optional(TrimmedNonEmptyStringSchema),
  providerOptions: Schema.optional(ProviderStartOptions),
  modelSelection: Schema.optional(ModelSelection),
  expectedHeadSha: Schema.optional(TrimmedNonEmptyStringSchema),
  expectedPatchSignature: Schema.optional(TrimmedNonEmptyStringSchema),
  textGenerationModel: Schema.optional(TrimmedNonEmptyStringSchema).pipe(
    Schema.withConstructorDefault(() => Option.some(DEFAULT_GIT_TEXT_GENERATION_MODEL)),
  ),
});
export type ReviewRunAgentInput = typeof ReviewRunAgentInput.Type;

export const ReviewAgentResult = Schema.Struct({
  summary: Schema.String,
  findings: Schema.Array(ReviewFinding),
  reviewedHeadSha: Schema.optional(TrimmedNonEmptyStringSchema),
  patchSignature: Schema.optional(TrimmedNonEmptyStringSchema),
  patchSource: Schema.optional(Schema.Literals(["github", "localFallback", "localBranchRange"])),
  totalFindings: Schema.optional(NonNegativeInt),
  anchoredFindings: Schema.optional(NonNegativeInt),
  droppedFindings: Schema.optional(NonNegativeInt),
  headMoved: Schema.optional(Schema.Boolean),
  patchChanged: Schema.optional(Schema.Boolean),
  warnings: Schema.optional(Schema.Array(Schema.String)),
});
export type ReviewAgentResult = typeof ReviewAgentResult.Type;

// ── GitHub Project (Projects v2) team kanban ─────────────────────────

export const ReviewProjectSummary = Schema.Struct({
  id: TrimmedNonEmptyStringSchema,
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.optional(Schema.String),
  ownerLogin: TrimmedNonEmptyStringSchema,
});
export type ReviewProjectSummary = typeof ReviewProjectSummary.Type;

export const ReviewProjectColumn = Schema.Struct({
  id: TrimmedNonEmptyStringSchema,
  name: TrimmedNonEmptyStringSchema,
});
export type ReviewProjectColumn = typeof ReviewProjectColumn.Type;

export const ReviewProjectCard = Schema.Struct({
  itemId: TrimmedNonEmptyStringSchema,
  columnId: Schema.NullOr(TrimmedNonEmptyStringSchema),
  number: Schema.NullOr(PositiveInt),
  title: Schema.String,
  url: Schema.optional(Schema.String),
  author: Schema.String,
  repositoryNameWithOwner: Schema.optional(Schema.String),
  isPullRequest: Schema.Boolean,
});
export type ReviewProjectCard = typeof ReviewProjectCard.Type;

export const ReviewProjectBoard = Schema.Struct({
  project: ReviewProjectSummary,
  statusFieldId: Schema.NullOr(TrimmedNonEmptyStringSchema),
  columns: Schema.Array(ReviewProjectColumn),
  cards: Schema.Array(ReviewProjectCard),
});
export type ReviewProjectBoard = typeof ReviewProjectBoard.Type;

export const ReviewCheckProjectAccessInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type ReviewCheckProjectAccessInput = typeof ReviewCheckProjectAccessInput.Type;

export const ReviewProjectAccessResult = Schema.Struct({
  hasProjectScope: Schema.Boolean,
});
export type ReviewProjectAccessResult = typeof ReviewProjectAccessResult.Type;

export const ReviewListProjectsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  owner: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ReviewListProjectsInput = typeof ReviewListProjectsInput.Type;

export const ReviewListProjectsResult = Schema.Struct({
  projects: Schema.Array(ReviewProjectSummary),
});
export type ReviewListProjectsResult = typeof ReviewListProjectsResult.Type;

export const ReviewGetProjectBoardInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  owner: TrimmedNonEmptyStringSchema,
  number: PositiveInt,
});
export type ReviewGetProjectBoardInput = typeof ReviewGetProjectBoardInput.Type;

export const ReviewMoveProjectCardInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  projectId: TrimmedNonEmptyStringSchema,
  itemId: TrimmedNonEmptyStringSchema,
  fieldId: TrimmedNonEmptyStringSchema,
  optionId: TrimmedNonEmptyStringSchema,
});
export type ReviewMoveProjectCardInput = typeof ReviewMoveProjectCardInput.Type;

export const ReviewMoveProjectCardResult = Schema.Struct({
  ok: Schema.Boolean,
});
export type ReviewMoveProjectCardResult = typeof ReviewMoveProjectCardResult.Type;

// ── Full PR review: detail, commits, checks, conversation ────────────
// The list summary and changeset carry only diff-side data. A real PR review
// also shows the description, reviewers/labels/assignees/milestone, mergeability,
// the commit list, per-check CI detail, and the conversation timeline. These
// schemas back the new gh-fetched endpoints that feed the PR overview.

// Shared input: every PR-detail endpoint takes a project cwd + a PR reference.
export const ReviewPullRequestQueryInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: ReviewPullRequestReference,
});
export type ReviewPullRequestQueryInput = typeof ReviewPullRequestQueryInput.Type;

export const ReviewPullRequestSurfaceInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: ReviewPullRequestReference,
  source: ReviewSourceRef,
  includeConversation: Schema.optional(Schema.Boolean),
  includeChangeset: Schema.optional(Schema.Boolean),
});
export type ReviewPullRequestSurfaceInput = typeof ReviewPullRequestSurfaceInput.Type;

export const ReviewLabel = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  // 6-digit hex without a leading '#', as GitHub returns it.
  color: Schema.String,
});
export type ReviewLabel = typeof ReviewLabel.Type;

export const ReviewUserRef = Schema.Struct({
  login: Schema.String,
  avatarUrl: Schema.optional(Schema.String),
});
export type ReviewUserRef = typeof ReviewUserRef.Type;

export const ReviewReviewerState = Schema.Literals([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING",
  "REVIEW_REQUIRED",
]);
export type ReviewReviewerState = typeof ReviewReviewerState.Type;

export const ReviewReviewer = Schema.Struct({
  login: Schema.String,
  avatarUrl: Schema.optional(Schema.String),
  state: ReviewReviewerState,
});
export type ReviewReviewer = typeof ReviewReviewer.Type;

export const ReviewMergeableState = Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]);
export type ReviewMergeableState = typeof ReviewMergeableState.Type;

export const ReviewPullRequestDetail = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  state: ReviewPullRequestState,
  isDraft: Schema.Boolean,
  author: Schema.String,
  authorAvatarUrl: Schema.optional(Schema.String),
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  body: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changedFiles: NonNegativeInt,
  commitsCount: NonNegativeInt,
  reviewDecision: Schema.NullOr(Schema.String),
  mergeable: ReviewMergeableState,
  mergeStateStatus: Schema.optional(Schema.String),
  checksStatus: Schema.Literals(["passing", "failing", "pending", "none"]),
  milestone: Schema.NullOr(Schema.String),
  labels: Schema.Array(ReviewLabel),
  assignees: Schema.Array(ReviewUserRef),
  reviewers: Schema.Array(ReviewReviewer),
});
export type ReviewPullRequestDetail = typeof ReviewPullRequestDetail.Type;

export const ReviewPullRequestHeaderDetail = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  state: ReviewPullRequestState,
  isDraft: Schema.Boolean,
  author: Schema.String,
  authorAvatarUrl: Schema.optional(Schema.String),
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  body: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changedFiles: NonNegativeInt,
  commitsCount: Schema.optional(NonNegativeInt),
  reviewDecision: Schema.NullOr(Schema.String),
  mergeable: ReviewMergeableState,
  mergeStateStatus: Schema.optional(Schema.String),
  checksStatus: Schema.optional(Schema.Literals(["passing", "failing", "pending", "none"])),
  milestone: Schema.NullOr(Schema.String),
  labels: Schema.Array(ReviewLabel),
  assignees: Schema.Array(ReviewUserRef),
  reviewers: Schema.optional(Schema.Array(ReviewReviewer)),
});
export type ReviewPullRequestHeaderDetail = typeof ReviewPullRequestHeaderDetail.Type;

export const ReviewPullRequestHeader = Schema.Struct({
  detail: ReviewPullRequestHeaderDetail,
});
export type ReviewPullRequestHeader = typeof ReviewPullRequestHeader.Type;

export const ReviewCommit = Schema.Struct({
  oid: TrimmedNonEmptyStringSchema,
  abbreviatedOid: TrimmedNonEmptyStringSchema,
  messageHeadline: Schema.String,
  messageBody: Schema.optional(Schema.String),
  author: Schema.String,
  authorAvatarUrl: Schema.optional(Schema.String),
  authoredDate: Schema.String,
});
export type ReviewCommit = typeof ReviewCommit.Type;

export const ReviewCommitsResult = Schema.Struct({
  commits: Schema.Array(ReviewCommit),
});
export type ReviewCommitsResult = typeof ReviewCommitsResult.Type;

export const ReviewCheckState = Schema.Literals([
  "success",
  "failure",
  "pending",
  "skipped",
  "neutral",
  "cancelled",
]);
export type ReviewCheckState = typeof ReviewCheckState.Type;

export const ReviewCheck = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  state: ReviewCheckState,
  workflow: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
});
export type ReviewCheck = typeof ReviewCheck.Type;

export const ReviewChecksResult = Schema.Struct({
  checks: Schema.Array(ReviewCheck),
});
export type ReviewChecksResult = typeof ReviewChecksResult.Type;

// One `gh pr view` call yields detail + commits + checks together; the overview
// query feeds the PR header, sidebar, Commits tab, and Checks tab from one fetch.
export const ReviewPullRequestOverview = Schema.Struct({
  detail: ReviewPullRequestDetail,
  commits: Schema.Array(ReviewCommit),
  checks: Schema.Array(ReviewCheck),
});
export type ReviewPullRequestOverview = typeof ReviewPullRequestOverview.Type;

// Conversation timeline — pragmatic subset (plan decision A): comments, reviews,
// commits, label/assign/milestone/review-requested, and merged/closed/reopened/
// force-push state events. Each variant is discriminated by `_tag`.
export const ReviewTimelineEvent = Schema.Union([
  Schema.TaggedStruct("comment", {
    id: TrimmedNonEmptyStringSchema,
    author: Schema.String,
    authorAvatarUrl: Schema.optional(Schema.String),
    body: Schema.String,
    createdAt: Schema.String,
    url: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("review", {
    id: TrimmedNonEmptyStringSchema,
    author: Schema.String,
    authorAvatarUrl: Schema.optional(Schema.String),
    state: ReviewReviewerState,
    body: Schema.String,
    createdAt: Schema.String,
    url: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("commit", {
    oid: TrimmedNonEmptyStringSchema,
    abbreviatedOid: TrimmedNonEmptyStringSchema,
    messageHeadline: Schema.String,
    author: Schema.String,
    createdAt: Schema.String,
  }),
  Schema.TaggedStruct("labeled", {
    actor: Schema.String,
    label: ReviewLabel,
    added: Schema.Boolean,
    createdAt: Schema.String,
  }),
  Schema.TaggedStruct("assigned", {
    actor: Schema.String,
    assignee: Schema.String,
    added: Schema.Boolean,
    createdAt: Schema.String,
  }),
  Schema.TaggedStruct("milestoned", {
    actor: Schema.String,
    milestone: Schema.String,
    added: Schema.Boolean,
    createdAt: Schema.String,
  }),
  Schema.TaggedStruct("reviewRequested", {
    actor: Schema.String,
    requestedReviewer: Schema.String,
    createdAt: Schema.String,
  }),
  Schema.TaggedStruct("merged", {
    actor: Schema.String,
    commitOid: Schema.optional(TrimmedNonEmptyStringSchema),
    createdAt: Schema.String,
  }),
  Schema.TaggedStruct("closed", {
    actor: Schema.String,
    createdAt: Schema.String,
  }),
  Schema.TaggedStruct("reopened", {
    actor: Schema.String,
    createdAt: Schema.String,
  }),
  Schema.TaggedStruct("headRefForcePushed", {
    actor: Schema.String,
    createdAt: Schema.String,
  }),
]);
export type ReviewTimelineEvent = typeof ReviewTimelineEvent.Type;

export const ReviewConversationResult = Schema.Struct({
  events: Schema.Array(ReviewTimelineEvent),
});
export type ReviewConversationResult = typeof ReviewConversationResult.Type;

export const ReviewPullRequestSurfaceResult = Schema.Struct({
  overview: ReviewPullRequestOverview,
  conversation: Schema.optional(ReviewConversationResult),
  changeset: Schema.optional(ReviewChangesetResult),
});
export type ReviewPullRequestSurfaceResult = typeof ReviewPullRequestSurfaceResult.Type;

export const ReviewUpdatedPayload = Schema.Union([
  Schema.TaggedStruct("pullRequestList", {
    cwd: TrimmedNonEmptyStringSchema,
    repositoryId: ReviewRepositoryId,
    state: ReviewListState,
    limit: Schema.optional(PositiveInt),
    search: Schema.optional(TrimmedNonEmptyStringSchema),
    author: Schema.optional(TrimmedNonEmptyStringSchema),
    authors: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
    reviewRequested: Schema.optional(TrimmedNonEmptyStringSchema),
    baseBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    baseBranches: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
    headBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    headBranches: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
    label: Schema.optional(TrimmedNonEmptyStringSchema),
    labels: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
    assignee: Schema.optional(TrimmedNonEmptyStringSchema),
    assignees: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
    draft: Schema.optional(Schema.Boolean),
    columns: Schema.optional(Schema.Array(ReviewListColumn)),
    checks: Schema.optional(Schema.Array(ReviewChecksStatus)),
    sort: Schema.optional(ReviewListSort),
    data: ReviewListPullRequestsResult,
    fetchedAt: NonNegativeInt,
  }),
  Schema.TaggedStruct("pullRequestOverview", {
    cwd: TrimmedNonEmptyStringSchema,
    repositoryId: ReviewRepositoryId,
    reference: ReviewPullRequestReference,
    data: ReviewPullRequestOverview,
    fetchedAt: NonNegativeInt,
  }),
  Schema.TaggedStruct("pullRequestConversation", {
    cwd: TrimmedNonEmptyStringSchema,
    repositoryId: ReviewRepositoryId,
    reference: ReviewPullRequestReference,
    data: ReviewConversationResult,
    fetchedAt: NonNegativeInt,
  }),
  Schema.TaggedStruct("pullRequestChangeset", {
    cwd: TrimmedNonEmptyStringSchema,
    repositoryId: ReviewRepositoryId,
    reference: ReviewPullRequestReference,
    data: ReviewChangesetResult,
    fetchedAt: NonNegativeInt,
  }),
  // Signal-only: no lane data (lanes are limit-keyed); the client refetches its board-lane query.
  Schema.TaggedStruct("boardLanes", {
    cwd: TrimmedNonEmptyStringSchema,
    repositoryId: ReviewRepositoryId,
    fetchedAt: NonNegativeInt,
  }),
]);
export type ReviewUpdatedPayload = typeof ReviewUpdatedPayload.Type;
