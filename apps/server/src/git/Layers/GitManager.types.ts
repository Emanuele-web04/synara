// Purpose: Pure types and constants for the GitManager layer.
// Layer: Layers (pure module-scope declarations; no Effect/service binding).
// Exports: COMMIT_TIMEOUT_MS, MAX_PROGRESS_TEXT_LENGTH, OPEN_PR_LOOKUP_LIMIT,
//   GitActionProgressPayload, OpenPrInfo, PullRequestInfo, ResolvedPullRequest,
//   PullRequestHeadRemoteInfo, BranchHeadContext, FailedLocalHandoffRecovery,
//   FailedLocalTransferRecovery, FailedWorktreeHandoffRecovery,
//   FailedWorktreeTransferRecovery, CommitAndBranchSuggestion,
//   FeatureBranchStepOptions.

import type { GitActionProgressEvent } from "@t3tools/contracts";

export const COMMIT_TIMEOUT_MS = 10 * 60_000;
export const MAX_PROGRESS_TEXT_LENGTH = 500;
export const OPEN_PR_LOOKUP_LIMIT = 10;

type StripProgressContext<T> = T extends any ? Omit<T, "actionId" | "cwd" | "action"> : never;
export type GitActionProgressPayload = StripProgressContext<GitActionProgressEvent>;

export interface OpenPrInfo {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  isCrossRepository?: boolean;
  headRepositoryNameWithOwner?: string | null;
  headRepositoryOwnerLogin?: string | null;
}

export interface PullRequestInfo extends OpenPrInfo {
  state: "open" | "closed" | "merged";
  updatedAt: string | null;
}

export interface ResolvedPullRequest {
  number: number;
  title: string;
  url: string;
  baseBranch: string;
  headBranch: string;
  state: "open" | "closed" | "merged";
}

export interface PullRequestHeadRemoteInfo {
  isCrossRepository?: boolean;
  headRepositoryNameWithOwner?: string | null;
  headRepositoryOwnerLogin?: string | null;
}

export interface BranchHeadContext {
  localBranch: string;
  headBranch: string;
  headSelectors: ReadonlyArray<string>;
  preferredHeadSelector: string;
  remoteName: string | null;
  headRepositoryNameWithOwner: string | null;
  headRepositoryOwnerLogin: string | null;
  isCrossRepository: boolean;
}

export interface FailedLocalHandoffRecovery {
  worktreeRecreated: boolean;
  worktreeChangesRestored: boolean;
  localChangesRestored: boolean;
  recoveryNotes: ReadonlyArray<string>;
}

export interface FailedLocalTransferRecovery extends FailedLocalHandoffRecovery {
  localCheckoutRestored: boolean;
}

export interface FailedWorktreeHandoffRecovery {
  checkoutRestored: boolean;
  stashRestored: boolean;
  recoveryNotes: ReadonlyArray<string>;
}

export interface FailedWorktreeTransferRecovery extends FailedWorktreeHandoffRecovery {
  worktreeRemoved: boolean;
}

export interface CommitAndBranchSuggestion {
  subject: string;
  body: string;
  branch?: string | undefined;
  commitMessage: string;
}

export interface FeatureBranchStepOptions {
  allowCommittedHead?: boolean;
  restoreOriginalBranchRef?: string | null;
}
