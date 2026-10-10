import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";
import type {
  GitBlameLineInput,
  GitReadFileAtRevInput,
  GitReadFileAtRevResult,
  GitBlameLineResult,
  GitCheckoutInput,
  GitCreateBranchInput,
  GitCreateDetachedWorktreeInput,
  GitWorktreeSetupPhase,
  GitCreateDetachedWorktreeResult,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitListRecentCommitsInput,
  GitListRecentCommitsResult,
  GitPullResult,
  GitRemoveIndexLockInput,
  GitRemoveWorktreeInput,
  GitStashAndCheckoutInput,
  GitStashDropInput,
  GitStashInfoInput,
  GitStashInfoResult,
  GitStatusInput,
  GitStatusResult,
  GitWorkingTreeDiffStatsResult,
} from "@synara/contracts";

import type { GitCheckoutDirtyWorktreeError, GitCommandError } from "../Errors.ts";

export interface ExecuteGitInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  /** null waits for completion or caller interruption without a wall-clock deadline. */
  readonly timeoutMs?: number | null;
  readonly maxOutputBytes?: number;
  readonly outputMode?: "error" | "truncate";
  readonly progress?: ExecuteGitProgress;
}

export interface ExecuteGitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
}

export interface GitStatusDetails extends Omit<GitStatusResult, "pr"> {
  isRepo: boolean;
  hasOriginRemote: boolean;
  isDefaultBranch: boolean;
  upstreamRef: string | null;
}

export interface GitBranchContext {
  readonly isRepo: boolean;
  readonly branch: string | null;
  readonly upstreamRef: string | null;
}

export type GitActionStatus = Pick<
  GitStatusDetails,
  "branch" | "upstreamRef" | "hasUpstream" | "aheadCount" | "behindCount" | "hasWorkingTreeChanges"
>;

export type GitDiffScope = "branch" | "staged" | "unstaged" | "workingTree" | "ref";

export interface GitPreparedCommitContext {
  stagedSummary: string;
  stagedPatch: string;
}

export interface ExecuteGitProgress {
  /** NUL records for machine-readable output containing arbitrary paths */
  readonly stdoutLineDelimiter?: "\n" | "\0";
  readonly onStdoutLine?: (line: string) => Effect.Effect<void, never>;
  readonly onStderrLine?: (line: string) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface GitCommitProgress {
  readonly onOutputLine?: (input: {
    stream: "stdout" | "stderr";
    text: string;
  }) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface GitCommitOptions {
  readonly timeoutMs?: number | null;
  readonly progress?: GitCommitProgress;
}

export interface GitPushResult {
  status: "pushed" | "skipped_up_to_date";
  branch: string;
  upstreamBranch?: string | undefined;
  setUpstream?: boolean | undefined;
}

export interface GitRangeContext {
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
}

export interface GitWorkingTreePatch {
  patch: string;
  truncated: boolean;
}

export interface GitRenameBranchInput {
  cwd: string;
  oldBranch: string;
  newBranch: string;
}

export interface GitRenameBranchResult {
  branch: string;
}

export interface GitDeleteBranchInput {
  cwd: string;
  branch: string;
  force?: boolean | undefined;
}

export interface GitWorktreeOwnershipProof {
  readonly token: string;
  readonly gitDir: string;
  readonly branch: string | null;
  readonly head: string;
  /** includes copied tracked, untracked, and .worktreeinclude files */
  readonly stateHash?: string;
}

export interface GitVerifyWorktreeOwnershipResult {
  readonly verified: boolean;
  readonly reason: string | null;
}

export interface GitSnapshotWorktreeInput {
  readonly cwd: string;
  readonly outputPath: string;
}

export interface GitFetchPullRequestBranchInput {
  cwd: string;
  prNumber: number;
  branch: string;
}

export interface GitFetchPullRequestCommitInput {
  cwd: string;
  prNumber: number;
  /** when a full PR URL, must match the remote used for the fetch */
  expectedRepositoryNameWithOwner?: string;
}

export interface GitEnsureRemoteInput {
  cwd: string;
  preferredName: string;
  url: string;
}

export interface GitFetchRemoteBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
  localBranch: string;
}

export interface GitSetBranchUpstreamInput {
  cwd: string;
  branch: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitPublishBranchInput {
  cwd: string;
  branch: string;
}

export interface GitCoreShape {
  /** serialize one mutation saga per canonical repository common dir */
  readonly withMutation: <A, E, R>(
    cwd: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | GitCommandError, R>;
  /**
   * Execute a raw Git command.
   * Instances in the same loaded module share four general finite slots, two finite
   * CheckpointStore.* slots and two long/network slots (eight total).
   * Long/network includes unlimited commands and commit, push, pull, fetch or clone.
   * Each FIFO class admits at most 128 queued callers; overload fails with GitCommandError.
   * Queue time precedes the command deadline, but counts toward enclosing caller deadlines.
   * Slots stay owned through process cleanup; push/fetch/pull/clone disable Git terminal prompting.
   * Background status refresh uses immediate admission and skips busy slots without enqueueing.
   */
  readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;

  /**
   * Read Git status from local refs; opportunistic background refresh may update a later read.
   */
  readonly status: (input: GitStatusInput) => Effect.Effect<GitStatusResult, GitCommandError>;

  /**
   * Read detailed working tree / branch status from local refs. Opportunistic background
   * refresh may update a later read; this response does not guarantee latest remote state.
   */
  readonly statusDetails: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;

  /**
   * Read action preconditions from local refs without collecting paths, contents or diff stats.
   * Opportunistic background refresh may update a later read, without delaying this response.
   */
  readonly readActionStatus: (cwd: string) => Effect.Effect<GitActionStatus, GitCommandError>;

  /** Read only branch identity, without diff stats or remote refresh work. */
  readonly readBranchContext: (cwd: string) => Effect.Effect<GitBranchContext, GitCommandError>;

  /** optional path limits the patch to that literal path and its rename source */
  readonly readWorkingTreePatch: (
    cwd: string,
    filePath?: string,
  ) => Effect.Effect<GitWorkingTreePatch, GitCommandError>;

  readonly readUnstagedPatch: (cwd: string) => Effect.Effect<GitWorkingTreePatch, GitCommandError>;

  readonly readStagedPatch: (cwd: string) => Effect.Effect<GitWorkingTreePatch, GitCommandError>;

  /** aggregate from the upstream/base merge-base through the working tree */
  readonly readBranchPatch: (cwd: string) => Effect.Effect<GitWorkingTreePatch, GitCommandError>;

  readonly blameLine: (
    input: GitBlameLineInput,
  ) => Effect.Effect<GitBlameLineResult, GitCommandError>;

  readonly readFileAtRev: (
    input: GitReadFileAtRevInput,
  ) => Effect.Effect<GitReadFileAtRevResult, GitCommandError>;

  readonly readRefPatch: (
    cwd: string,
    ref: string,
  ) => Effect.Effect<GitWorkingTreePatch, GitCommandError>;

  /** aggregate diff counts without materializing a unified patch */
  readonly readDiffStats: (
    cwd: string,
    scope: GitDiffScope,
    ref?: string,
  ) => Effect.Effect<GitWorkingTreeDiffStatsResult, GitCommandError>;

  readonly prepareCommitContext: (
    cwd: string,
    filePaths?: readonly string[],
  ) => Effect.Effect<GitPreparedCommitContext | null, GitCommandError>;

  readonly commit: (
    cwd: string,
    subject: string,
    body: string,
    options?: GitCommitOptions,
  ) => Effect.Effect<{ commitSha: string }, GitCommandError>;

  readonly pushCurrentBranch: (
    cwd: string,
    fallbackBranch: string | null,
  ) => Effect.Effect<GitPushResult, GitCommandError>;

  readonly readRangeContext: (
    cwd: string,
    baseBranch: string,
  ) => Effect.Effect<GitRangeContext, GitCommandError>;

  readonly readConfigValue: (
    cwd: string,
    key: string,
  ) => Effect.Effect<string | null, GitCommandError>;

  readonly listBranches: (
    input: GitListBranchesInput,
  ) => Effect.Effect<GitListBranchesResult, GitCommandError>;

  readonly listRecentCommits: (
    input: GitListRecentCommitsInput,
  ) => Effect.Effect<GitListRecentCommitsResult, GitCommandError>;

  readonly pullCurrentBranch: (cwd: string) => Effect.Effect<GitPullResult, GitCommandError>;

  readonly createWorktree: (
    input: GitCreateWorktreeInput,
  ) => Effect.Effect<GitCreateWorktreeResult, GitCommandError>;

  /** non-versioned marker on a linked worktree's Git admin entry */
  readonly recordWorktreeOwnership: (input: {
    readonly path: string;
    readonly branch: string | null;
    readonly token: string;
  }) => Effect.Effect<GitWorktreeOwnershipProof, GitCommandError>;

  /** verify a linked worktree is still the unchanged marked object */
  readonly verifyWorktreeOwnership: (input: {
    readonly path: string;
    readonly proof: GitWorktreeOwnershipProof;
  }) => Effect.Effect<GitVerifyWorktreeOwnershipResult, GitCommandError>;

  /** snapshot tracked changes + transferable local files before managed cleanup */
  readonly snapshotWorktree: (
    input: GitSnapshotWorktreeInput,
  ) => Effect.Effect<void, GitCommandError>;

  /** `onPhase` fires as each setup phase (branch → worktree → copy-changes) begins */
  readonly createDetachedWorktree: (
    input: GitCreateDetachedWorktreeInput,
    options?: {
      readonly onPhase?: (phase: GitWorktreeSetupPhase) => Effect.Effect<void>;
    },
  ) => Effect.Effect<GitCreateDetachedWorktreeResult, GitCommandError>;

  /** materialize a PR head as a local branch without switching checkout */
  readonly fetchPullRequestBranch: (
    input: GitFetchPullRequestBranchInput,
  ) => Effect.Effect<void, GitCommandError>;

  /** fetch a PR head without creating or occupying a local branch */
  readonly fetchPullRequestCommit: (
    input: GitFetchPullRequestCommitInput,
  ) => Effect.Effect<string, GitCommandError>;

  readonly ensureRemote: (input: GitEnsureRemoteInput) => Effect.Effect<string, GitCommandError>;

  readonly fetchRemoteBranch: (
    input: GitFetchRemoteBranchInput,
  ) => Effect.Effect<void, GitCommandError>;

  readonly setBranchUpstream: (
    input: GitSetBranchUpstreamInput,
  ) => Effect.Effect<void, GitCommandError>;

  readonly removeWorktree: (input: GitRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>;

  readonly deleteBranch: (input: GitDeleteBranchInput) => Effect.Effect<void, GitCommandError>;

  /** atomic delete only when the branch still points at the expected object id */
  readonly deleteBranchIfUnchanged: (input: {
    readonly cwd: string;
    readonly branch: string;
    readonly expectedHead: string;
  }) => Effect.Effect<void, GitCommandError>;

  readonly renameBranch: (
    input: GitRenameBranchInput,
  ) => Effect.Effect<GitRenameBranchResult, GitCommandError>;

  readonly createBranch: (input: GitCreateBranchInput) => Effect.Effect<void, GitCommandError>;

  readonly publishBranch: (input: GitPublishBranchInput) => Effect.Effect<void, GitCommandError>;

  readonly checkoutBranch: (
    input: GitCheckoutInput,
  ) => Effect.Effect<void, GitCommandError | GitCheckoutDirtyWorktreeError, Scope.Scope>;

  readonly stashAndCheckout: (
    input: GitStashAndCheckoutInput,
  ) => Effect.Effect<void, GitCommandError | GitCheckoutDirtyWorktreeError, Scope.Scope>;

  /** drop the stash entry the caller inspected */
  readonly stashDrop: (input: GitStashDropInput) => Effect.Effect<void, GitCommandError>;

  readonly stashInfo: (
    input: GitStashInfoInput,
  ) => Effect.Effect<GitStashInfoResult, GitCommandError>;

  readonly removeIndexLock: (
    input: GitRemoveIndexLockInput,
  ) => Effect.Effect<void, GitCommandError>;

  readonly initRepo: (input: GitInitInput) => Effect.Effect<void, GitCommandError>;

  readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;

  readonly stageFiles: (
    cwd: string,
    paths: readonly string[],
  ) => Effect.Effect<void, GitCommandError>;

  /** handles the pre-initial-commit case */
  readonly unstageFiles: (
    cwd: string,
    paths: readonly string[],
  ) => Effect.Effect<void, GitCommandError>;
}

export class GitCore extends ServiceMap.Service<GitCore, GitCoreShape>()(
  "synara/git/Services/GitCore",
) {}
