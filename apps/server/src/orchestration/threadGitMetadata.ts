import type { OrchestrationThreadPullRequest } from "@synara/contracts";
import { resolveThreadBranchRegressionGuard } from "@synara/shared/git";
import { threadPullRequestsEqual } from "@synara/shared/threadPullRequestLinks";

export type ThreadPullRequestLookup =
  | {
      readonly status: "resolved";
      readonly pullRequest: OrchestrationThreadPullRequest | null;
    }
  | { readonly status: "unavailable" };

export interface ThreadGitMetadataPatch {
  readonly branch?: string | null;
  /** The branch-managed (`discovered`) PR; explicit links are never part of this patch. */
  readonly discoveredPullRequest?: OrchestrationThreadPullRequest | null;
  readonly associatedWorktreePath?: string | null;
  readonly associatedWorktreeBranch?: string | null;
  readonly associatedWorktreeRef?: string | null;
}

/**
 * Derives the durable thread metadata observed at a provider-turn boundary.
 *
 * The PR rules below only govern the branch-managed link. PRs the user, the agent, or the app's
 * own create/checkout flows linked explicitly are separate links that branch movement never
 * removes.
 *
 * Dedicated worktree: a successful lookup may intentionally clear a prior PR when the current
 * branch has none. A transient lookup failure preserves a PR on an unchanged branch, but clears
 * it when the branch itself changed so the sidebar never labels the new branch with the previous
 * branch's PR.
 *
 * Shared checkout (no `dedicatedWorktree`): the checkout's branch can move for reasons unrelated
 * to the thread, so a branch without a PR is not evidence that the thread lost its PR. The stored
 * PR is only replaced when a PR is actually found on the observed branch, never cleared.
 */
export function deriveThreadGitMetadataPatch(input: {
  readonly currentBranch: string | null;
  /** The thread's current branch-managed PR (not the overall current PR). */
  readonly currentPullRequest: OrchestrationThreadPullRequest | null;
  readonly observedBranch: string | null;
  readonly pullRequestLookup: ThreadPullRequestLookup;
  readonly dedicatedWorktree?: {
    readonly cwd: string;
    readonly currentPath: string | null;
    readonly currentBranch: string | null;
  };
}): ThreadGitMetadataPatch | null {
  const guardedBranch = resolveThreadBranchRegressionGuard({
    currentBranch: input.currentBranch,
    nextBranch: input.observedBranch,
  });
  if (guardedBranch !== input.observedBranch) {
    return null;
  }

  const branchChanged = input.currentBranch !== input.observedBranch;
  let nextPullRequest = input.currentPullRequest;

  if (input.dedicatedWorktree === undefined) {
    if (input.pullRequestLookup.status === "resolved" && input.pullRequestLookup.pullRequest) {
      nextPullRequest = input.pullRequestLookup.pullRequest;
    }
  } else if (input.observedBranch === null) {
    nextPullRequest = null;
  } else if (input.pullRequestLookup.status === "resolved") {
    nextPullRequest = input.pullRequestLookup.pullRequest;
  } else if (branchChanged) {
    nextPullRequest = null;
  }

  const pullRequestChanged = !threadPullRequestsEqual(input.currentPullRequest, nextPullRequest);
  const dedicatedWorktree = input.dedicatedWorktree;
  const associatedPathChanged =
    dedicatedWorktree !== undefined && dedicatedWorktree.currentPath !== dedicatedWorktree.cwd;
  const associatedBranchChanged =
    input.observedBranch !== null &&
    dedicatedWorktree !== undefined &&
    dedicatedWorktree.currentBranch !== input.observedBranch;
  const associatedWorktreePatch =
    dedicatedWorktree !== undefined && (associatedPathChanged || associatedBranchChanged)
      ? {
          ...(associatedPathChanged ? { associatedWorktreePath: dedicatedWorktree.cwd } : {}),
          ...(associatedBranchChanged
            ? {
                associatedWorktreeBranch: input.observedBranch,
                associatedWorktreeRef: input.observedBranch,
              }
            : {}),
        }
      : null;
  if (!branchChanged && !pullRequestChanged && associatedWorktreePatch === null) {
    return null;
  }

  return {
    ...(branchChanged ? { branch: input.observedBranch } : {}),
    ...(pullRequestChanged ? { discoveredPullRequest: nextPullRequest } : {}),
    ...(associatedWorktreePatch ?? {}),
  };
}
