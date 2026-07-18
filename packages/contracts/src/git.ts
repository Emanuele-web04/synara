import { Option, Schema } from "effect";
import {
  CommandId,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { DEFAULT_GIT_TEXT_GENERATION_MODEL } from "./model";
import { ModelSelection, ProviderStartOptions } from "./orchestration";
import { GitHubAccountSelection } from "./github";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

// Domain Types

export const GitStackedAction = Schema.Literals([
  "commit",
  "push",
  "create_pr",
  "commit_push",
  "commit_push_pr",
]);
export type GitStackedAction = typeof GitStackedAction.Type;
export const GitActionProgressPhase = Schema.Literals(["branch", "commit", "push", "pr"]);
export type GitActionProgressPhase = typeof GitActionProgressPhase.Type;
export const GitActionProgressKind = Schema.Literals([
  "action_started",
  "phase_started",
  "hook_started",
  "hook_output",
  "hook_finished",
  "action_finished",
  "action_failed",
]);
export type GitActionProgressKind = typeof GitActionProgressKind.Type;
export const GitActionProgressStream = Schema.Literals(["stdout", "stderr"]);
export type GitActionProgressStream = typeof GitActionProgressStream.Type;
const GitCommitStepStatus = Schema.Literals([
  "created",
  "skipped_no_changes",
  "skipped_not_requested",
]);
const GitPushStepStatus = Schema.Literals([
  "pushed",
  "skipped_not_requested",
  "skipped_up_to_date",
]);
const GitBranchStepStatus = Schema.Literals(["created", "skipped_not_requested"]);
const GitPrStepStatus = Schema.Literals(["created", "opened_existing", "skipped_not_requested"]);
const GitStatusPrState = Schema.Literals(["open", "closed", "merged"]);
const GitPullRequestReference = TrimmedNonEmptyStringSchema;
const GitPullRequestState = Schema.Literals(["open", "closed", "merged"]);
export const GitPullRequestListFilter = Schema.Literals([
  "all",
  "reviewing",
  "authored",
  "open",
  "closed",
  "merged",
]);
export type GitPullRequestListFilter = typeof GitPullRequestListFilter.Type;
// GitHub's mergeability is eventually consistent: "unknown" is a real transient state
// while GitHub recomputes after a push, not a decode fallback to branch on.
export const GitPullRequestMergeability = Schema.Literals(["mergeable", "conflicting", "unknown"]);
export type GitPullRequestMergeability = typeof GitPullRequestMergeability.Type;
const GitPreparePullRequestThreadMode = Schema.Literals(["local", "worktree"]);
const GitHandoffThreadMode = Schema.Literals(["local", "worktree"]);

export const GitBranch = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  isRemote: Schema.optional(Schema.Boolean),
  remoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type GitBranch = typeof GitBranch.Type;

const GitWorktree = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema,
});
const GitDetachedWorktree = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  ref: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
const GitResolvedPullRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  state: GitPullRequestState,
  isDraft: Schema.Boolean,
  mergeability: GitPullRequestMergeability,
  // Null when `gh` did not report diff sizes, so the UI can hide the stat instead of
  // rendering a misleading "+0 −0".
  additions: Schema.NullOr(NonNegativeInt),
  deletions: Schema.NullOr(NonNegativeInt),
  changedFiles: Schema.NullOr(NonNegativeInt),
});
export type GitResolvedPullRequest = typeof GitResolvedPullRequest.Type;

export const GitPullRequestListItem = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: TrimmedNonEmptyStringSchema,
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  state: GitPullRequestState,
  isDraft: Schema.Boolean,
  authorLogin: Schema.NullOr(TrimmedNonEmptyStringSchema),
  authorAvatarUrl: Schema.NullOr(TrimmedNonEmptyStringSchema),
  updatedAt: Schema.NullOr(TrimmedNonEmptyStringSchema),
  additions: Schema.NullOr(NonNegativeInt),
  deletions: Schema.NullOr(NonNegativeInt),
});
export type GitPullRequestListItem = typeof GitPullRequestListItem.Type;

// Normalized CI check state combining GitHub CheckRun conclusions and commit status states.
export const GitPullRequestCheckStatus = Schema.Literals([
  "pending",
  "success",
  "failure",
  "skipped",
  "neutral",
  "cancelled",
]);
export type GitPullRequestCheckStatus = typeof GitPullRequestCheckStatus.Type;

export const GitPullRequestCheck = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  status: GitPullRequestCheckStatus,
  url: Schema.NullOr(Schema.String),
});
export type GitPullRequestCheck = typeof GitPullRequestCheck.Type;

// Root comment of an unresolved review thread (resolved threads and replies are excluded).
export const GitPullRequestComment = Schema.Struct({
  id: TrimmedNonEmptyStringSchema,
  author: Schema.NullOr(TrimmedNonEmptyStringSchema),
  body: Schema.String,
  path: Schema.NullOr(TrimmedNonEmptyStringSchema),
  url: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type GitPullRequestComment = typeof GitPullRequestComment.Type;

// RPC Inputs

export const GitStatusInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  account: Schema.optional(GitHubAccountSelection),
});
export type GitStatusInput = typeof GitStatusInput.Type;

export const GitHubRepositoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  account: Schema.optional(GitHubAccountSelection),
});
export type GitHubRepositoryInput = typeof GitHubRepositoryInput.Type;

export const GitReadWorkingTreeDiffInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  scope: Schema.optional(Schema.Literals(["workingTree", "unstaged", "staged", "branch"])).pipe(
    Schema.withConstructorDefault(() => Option.some("workingTree" as const)),
  ),
});
export type GitReadWorkingTreeDiffInput = typeof GitReadWorkingTreeDiffInput.Type;

export const GitPullInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type GitPullInput = typeof GitPullInput.Type;

// Read-only diff summary requests reuse the shared git text-generation model settings.
export const GitSummarizeDiffInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  scope: Schema.optional(Schema.Literals(["workingTree", "unstaged", "staged", "branch"])).pipe(
    Schema.withConstructorDefault(() => Option.some("workingTree" as const)),
  ),
  codexHomePath: Schema.optional(TrimmedNonEmptyStringSchema),
  providerOptions: Schema.optional(ProviderStartOptions),
  textGenerationModel: Schema.optional(TrimmedNonEmptyStringSchema).pipe(
    Schema.withConstructorDefault(() => Option.some(DEFAULT_GIT_TEXT_GENERATION_MODEL)),
  ),
  textGenerationModelSelection: Schema.optional(ModelSelection),
});
export type GitSummarizeDiffInput = typeof GitSummarizeDiffInput.Type;

export const GitRunStackedActionInput = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
  account: Schema.optional(GitHubAccountSelection),
  baseBranch: Schema.optional(TrimmedNonEmptyStringSchema),
  commitMessage: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(10_000))),
  featureBranch: Schema.optional(Schema.Boolean),
  filePaths: Schema.optional(
    Schema.Array(TrimmedNonEmptyStringSchema).check(Schema.isMinLength(1)),
  ),
  codexHomePath: Schema.optional(TrimmedNonEmptyStringSchema),
  providerOptions: Schema.optional(ProviderStartOptions),
  textGenerationModel: Schema.optional(TrimmedNonEmptyStringSchema).pipe(
    Schema.withConstructorDefault(() => Option.some(DEFAULT_GIT_TEXT_GENERATION_MODEL)),
  ),
  textGenerationModelSelection: Schema.optional(ModelSelection),
});
export type GitRunStackedActionInput = typeof GitRunStackedActionInput.Type;

export const GitListBranchesInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type GitListBranchesInput = typeof GitListBranchesInput.Type;

export const GitListPullRequestsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  filter: GitPullRequestListFilter,
  account: Schema.optional(GitHubAccountSelection),
});
export type GitListPullRequestsInput = typeof GitListPullRequestsInput.Type;

export const GitCreateWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema,
  newBranch: Schema.optional(TrimmedNonEmptyStringSchema),
  path: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type GitCreateWorktreeInput = typeof GitCreateWorktreeInput.Type;

export const GitCreateDetachedWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  ref: TrimmedNonEmptyStringSchema,
  path: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type GitCreateDetachedWorktreeInput = typeof GitCreateDetachedWorktreeInput.Type;

export const GitPullRequestRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
  account: Schema.optional(GitHubAccountSelection),
});
export type GitPullRequestRefInput = typeof GitPullRequestRefInput.Type;

export const GitPullRequestSnapshotInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
  account: Schema.optional(GitHubAccountSelection),
});
export type GitPullRequestSnapshotInput = typeof GitPullRequestSnapshotInput.Type;

export const GitPreparePullRequestThreadInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
  mode: GitPreparePullRequestThreadMode,
  managedWorktreePath: Schema.optional(TrimmedNonEmptyStringSchema),
  account: Schema.optional(GitHubAccountSelection),
});
export type GitPreparePullRequestThreadInput = typeof GitPreparePullRequestThreadInput.Type;

export const GitHandoffThreadInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  cwd: TrimmedNonEmptyStringSchema,
  targetMode: GitHandoffThreadMode,
  currentBranch: Schema.NullOr(TrimmedNonEmptyStringSchema),
  worktreePath: Schema.NullOr(TrimmedNonEmptyStringSchema),
  associatedWorktreePath: Schema.NullOr(TrimmedNonEmptyStringSchema),
  associatedWorktreeBranch: Schema.NullOr(TrimmedNonEmptyStringSchema),
  associatedWorktreeRef: Schema.NullOr(TrimmedNonEmptyStringSchema),
  preferredLocalBranch: Schema.NullOr(TrimmedNonEmptyStringSchema),
  preferredWorktreeBaseBranch: Schema.NullOr(TrimmedNonEmptyStringSchema),
  preferredNewWorktreeName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  preserveWorktree: Schema.optional(Schema.Boolean),
});
export type GitHandoffThreadInput = typeof GitHandoffThreadInput.Type;

export const GitRemoveWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  path: TrimmedNonEmptyStringSchema,
  force: Schema.optional(Schema.Boolean),
});
export type GitRemoveWorktreeInput = typeof GitRemoveWorktreeInput.Type;

export const GitCreateBranchInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema,
  publish: Schema.optional(Schema.Boolean),
});
export type GitCreateBranchInput = typeof GitCreateBranchInput.Type;

export const GitRenameBranchInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  oldBranch: TrimmedNonEmptyStringSchema,
  newBranch: TrimmedNonEmptyStringSchema,
});
export type GitRenameBranchInput = typeof GitRenameBranchInput.Type;

export const GitCloneRepositoryInput = Schema.Struct({
  repository: TrimmedNonEmptyStringSchema,
  account: Schema.optional(GitHubAccountSelection),
});
export type GitCloneRepositoryInput = typeof GitCloneRepositoryInput.Type;

export const GitHubListAccountsInput = Schema.Struct({});
export type GitHubListAccountsInput = typeof GitHubListAccountsInput.Type;

export const GitHubListRepositoriesInput = Schema.Struct({
  account: Schema.optional(GitHubAccountSelection),
});
export type GitHubListRepositoriesInput = typeof GitHubListRepositoriesInput.Type;

export const GitCheckoutInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema,
});
export type GitCheckoutInput = typeof GitCheckoutInput.Type;

export const GitStashAndCheckoutInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema,
});
export type GitStashAndCheckoutInput = typeof GitStashAndCheckoutInput.Type;

export const GitStashDropInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  stashRef: TrimmedNonEmptyStringSchema,
});
export type GitStashDropInput = typeof GitStashDropInput.Type;

export const GitStashInfoInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type GitStashInfoInput = typeof GitStashInfoInput.Type;

export const GitRemoveIndexLockInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type GitRemoveIndexLockInput = typeof GitRemoveIndexLockInput.Type;

export const GitInitInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type GitInitInput = typeof GitInitInput.Type;

export const GitStageFilesInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  paths: Schema.Array(TrimmedNonEmptyStringSchema).check(Schema.isMinLength(1)),
});
export type GitStageFilesInput = typeof GitStageFilesInput.Type;

export const GitUnstageFilesInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  paths: Schema.Array(TrimmedNonEmptyStringSchema).check(Schema.isMinLength(1)),
});
export type GitUnstageFilesInput = typeof GitUnstageFilesInput.Type;

// RPC Results

const GitStatusPr = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  state: GitStatusPrState,
  isDraft: Schema.Boolean,
  mergeability: GitPullRequestMergeability,
  additions: Schema.NullOr(NonNegativeInt),
  deletions: Schema.NullOr(NonNegativeInt),
  changedFiles: Schema.NullOr(NonNegativeInt),
});

export const GitBranchPublication = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("local_only"),
  }),
  Schema.Struct({
    state: Schema.Literal("upstream"),
    remoteBranch: TrimmedNonEmptyStringSchema,
  }),
  Schema.Struct({
    state: Schema.Literal("published"),
    remoteBranch: TrimmedNonEmptyStringSchema,
    url: TrimmedNonEmptyStringSchema,
  }),
  Schema.Struct({
    state: Schema.Literal("stale_upstream"),
    remoteBranch: TrimmedNonEmptyStringSchema,
  }),
]);
export type GitBranchPublication = typeof GitBranchPublication.Type;

export const GitStatusResult = Schema.Struct({
  branch: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  hasWorkingTreeChanges: Schema.Boolean,
  workingTree: Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        // Git paths are byte-preserving strings and may legitimately begin or end in whitespace.
        path: Schema.String.check(Schema.isNonEmpty()),
        insertions: NonNegativeInt,
        deletions: NonNegativeInt,
      }),
    ),
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
    /** Exact when known; null when malformed output prevents a reliable count. */
    totalFiles: Schema.optional(NonNegativeInt.pipe(Schema.NullOr)),
    /** True when any working-tree detail or aggregate is incomplete. */
    isPartial: Schema.optional(Schema.Boolean),
    /** True when the bounded file-detail list omitted otherwise valid entries. */
    truncated: Schema.optional(Schema.Boolean),
    /** Whether insertion/deletion aggregates cover the complete working tree. */
    statisticsState: Schema.optional(Schema.Literals(["complete", "partial", "unknown"])),
  }),
  hasUpstream: Schema.Boolean,
  upstreamBranch: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  aheadCount: NonNegativeInt,
  behindCount: NonNegativeInt,
  publication: Schema.optional(GitBranchPublication),
  pr: Schema.NullOr(GitStatusPr),
  /** True when live PR discovery failed and persisted workspace metadata should be retained. */
  prUnavailable: Schema.optional(Schema.Boolean),
});
export type GitStatusResult = typeof GitStatusResult.Type;

export const GitStatusLocalResult = Schema.Struct({
  branch: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  hasWorkingTreeChanges: Schema.Boolean,
  workingTree: GitStatusResult.fields.workingTree,
});
export type GitStatusLocalResult = typeof GitStatusLocalResult.Type;

export const GitStatusRemoteResult = Schema.Struct({
  hasUpstream: Schema.Boolean,
  upstreamBranch: GitStatusResult.fields.upstreamBranch,
  aheadCount: NonNegativeInt,
  behindCount: NonNegativeInt,
  publication: GitStatusResult.fields.publication,
  pr: Schema.NullOr(GitStatusPr),
  prUnavailable: GitStatusResult.fields.prUnavailable,
});
export type GitStatusRemoteResult = typeof GitStatusRemoteResult.Type;

export const GitHubRepositoryResult = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      nameWithOwner: TrimmedNonEmptyStringSchema,
      url: TrimmedNonEmptyStringSchema,
    }),
  ),
  repositories: Schema.Array(
    Schema.Struct({
      nameWithOwner: TrimmedNonEmptyStringSchema,
      url: TrimmedNonEmptyStringSchema,
    }),
  ),
});
export type GitHubRepositoryResult = typeof GitHubRepositoryResult.Type;

export const GitStatusStreamEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    local: GitStatusLocalResult,
    remote: Schema.NullOr(GitStatusRemoteResult),
  }),
  Schema.TaggedStruct("localUpdated", {
    local: GitStatusLocalResult,
  }),
  Schema.TaggedStruct("remoteUpdated", {
    remote: Schema.NullOr(GitStatusRemoteResult),
  }),
]);
export type GitStatusStreamEvent = typeof GitStatusStreamEvent.Type;

export const GitReadWorkingTreeDiffResult = Schema.Struct({
  patch: Schema.String,
});
export type GitReadWorkingTreeDiffResult = typeof GitReadWorkingTreeDiffResult.Type;

// Stage/unstage are fire-and-forget index mutations; callers refetch status/diff.
export const GitStageFilesResult = Schema.Struct({
  ok: Schema.Boolean,
});
export type GitStageFilesResult = typeof GitStageFilesResult.Type;

export const GitUnstageFilesResult = GitStageFilesResult;
export type GitUnstageFilesResult = GitStageFilesResult;

export const GitListBranchesResult = Schema.Struct({
  branches: Schema.Array(GitBranch),
  isRepo: Schema.Boolean,
  hasOriginRemote: Schema.Boolean,
});
export type GitListBranchesResult = typeof GitListBranchesResult.Type;

export const GitListPullRequestsResult = Schema.Struct({
  pullRequests: Schema.Array(GitPullRequestListItem),
});
export type GitListPullRequestsResult = typeof GitListPullRequestsResult.Type;

export const GitCreateWorktreeResult = Schema.Struct({
  worktree: GitWorktree,
});
export type GitCreateWorktreeResult = typeof GitCreateWorktreeResult.Type;

export const GitCreateDetachedWorktreeResult = Schema.Struct({
  worktree: GitDetachedWorktree,
});
export type GitCreateDetachedWorktreeResult = typeof GitCreateDetachedWorktreeResult.Type;

export const GitRenameBranchResult = Schema.Struct({
  branch: TrimmedNonEmptyStringSchema,
});
export type GitRenameBranchResult = typeof GitRenameBranchResult.Type;

export const GitCloneRepositoryResult = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  nameWithOwner: TrimmedNonEmptyStringSchema,
  defaultBranch: TrimmedNonEmptyStringSchema,
  reused: Schema.Boolean,
});
export type GitCloneRepositoryResult = typeof GitCloneRepositoryResult.Type;

export const GitHubRepositorySummary = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyStringSchema,
  url: TrimmedNonEmptyStringSchema,
  description: Schema.NullOr(Schema.String),
  defaultBranch: Schema.NullOr(TrimmedNonEmptyStringSchema),
  pushedAt: Schema.NullOr(TrimmedNonEmptyStringSchema),
  isPrivate: Schema.Boolean,
  isArchived: Schema.Boolean,
});
export type GitHubRepositorySummary = typeof GitHubRepositorySummary.Type;

export const GitHubAccountSummary = Schema.Struct({
  host: TrimmedNonEmptyStringSchema,
  login: TrimmedNonEmptyStringSchema,
  active: Schema.Boolean,
});
export type GitHubAccountSummary = typeof GitHubAccountSummary.Type;

export const GitHubListAccountsResult = Schema.Struct({
  accounts: Schema.Array(GitHubAccountSummary),
});
export type GitHubListAccountsResult = typeof GitHubListAccountsResult.Type;

export const GitHubListRepositoriesResult = Schema.Struct({
  repositories: Schema.Array(GitHubRepositorySummary),
});
export type GitHubListRepositoriesResult = typeof GitHubListRepositoriesResult.Type;

export const GitStashInfoResult = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  stashRef: TrimmedNonEmptyStringSchema,
  message: TrimmedNonEmptyStringSchema,
  files: Schema.Array(TrimmedNonEmptyStringSchema),
});
export type GitStashInfoResult = typeof GitStashInfoResult.Type;

export const GitResolvePullRequestResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
});
export type GitResolvePullRequestResult = typeof GitResolvePullRequestResult.Type;

// Live CI + review-comment snapshot for one PR (drives the Environment panel PR section).
export const GitPullRequestSnapshotResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
  checks: Schema.Array(GitPullRequestCheck),
  comments: Schema.Array(GitPullRequestComment),
  commentsTruncated: Schema.Boolean,
  commentsError: Schema.NullOr(Schema.String),
});
export type GitPullRequestSnapshotResult = typeof GitPullRequestSnapshotResult.Type;

export const GitPreparePullRequestThreadResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
  branch: TrimmedNonEmptyStringSchema,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  targetResolvedCommit: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type GitPreparePullRequestThreadResult = typeof GitPreparePullRequestThreadResult.Type;

export const GitHandoffThreadResult = Schema.Struct({
  targetMode: GitHandoffThreadMode,
  branch: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  associatedWorktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  associatedWorktreeBranch: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  associatedWorktreeRef: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  changesTransferred: Schema.Boolean,
  conflictsDetected: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
});
export type GitHandoffThreadResult = typeof GitHandoffThreadResult.Type;

export const GitRunStackedActionResult = Schema.Struct({
  action: GitStackedAction,
  branch: Schema.Struct({
    status: GitBranchStepStatus,
    name: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  commit: Schema.Struct({
    status: GitCommitStepStatus,
    commitSha: Schema.optional(TrimmedNonEmptyStringSchema),
    subject: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  push: Schema.Struct({
    status: GitPushStepStatus,
    branch: Schema.optional(TrimmedNonEmptyStringSchema),
    upstreamBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    setUpstream: Schema.optional(Schema.Boolean),
  }),
  pr: Schema.Struct({
    status: GitPrStepStatus,
    url: Schema.optional(Schema.String),
    number: Schema.optional(PositiveInt),
    baseBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    headBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    title: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
});
export type GitRunStackedActionResult = typeof GitRunStackedActionResult.Type;

export const GitPullResult = Schema.Struct({
  status: Schema.Literals(["pulled", "skipped_up_to_date"]),
  branch: TrimmedNonEmptyStringSchema,
  upstreamBranch: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type GitPullResult = typeof GitPullResult.Type;

export const GitSummarizeDiffResult = Schema.Struct({
  summary: TrimmedNonEmptyStringSchema,
});
export type GitSummarizeDiffResult = typeof GitSummarizeDiffResult.Type;

const GitActionProgressBase = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
});

const GitActionStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_started"),
  phases: Schema.Array(GitActionProgressPhase),
});
const GitActionPhaseStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("phase_started"),
  phase: GitActionProgressPhase,
  label: TrimmedNonEmptyStringSchema,
});
const GitActionHookStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_started"),
  hookName: TrimmedNonEmptyStringSchema,
});
const GitActionHookOutputEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_output"),
  hookName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  stream: GitActionProgressStream,
  text: TrimmedNonEmptyStringSchema,
});
const GitActionHookFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_finished"),
  hookName: TrimmedNonEmptyStringSchema,
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(NonNegativeInt),
});
const GitActionFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_finished"),
  result: GitRunStackedActionResult,
});
const GitActionFailedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_failed"),
  phase: Schema.NullOr(GitActionProgressPhase),
  message: TrimmedNonEmptyStringSchema,
});

export const GitActionProgressEvent = Schema.Union([
  GitActionStartedEvent,
  GitActionPhaseStartedEvent,
  GitActionHookStartedEvent,
  GitActionHookOutputEvent,
  GitActionHookFinishedEvent,
  GitActionFinishedEvent,
  GitActionFailedEvent,
]);
export type GitActionProgressEvent = typeof GitActionProgressEvent.Type;
