import type { OrchestrationThreadPullRequest } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { deriveThreadGitMetadataPatch } from "./threadGitMetadata.ts";

const pullRequest: OrchestrationThreadPullRequest = {
  number: 574,
  title: "Cache provider usage",
  url: "https://github.com/Emanuele-web04/synara/pull/574",
  baseBranch: "main",
  headBranch: "feat/provider-usage-snapshot-cache",
  state: "open",
  isDraft: false,
  mergeability: "unknown",
  additions: 10,
  deletions: 2,
  changedFiles: 3,
};

describe("deriveThreadGitMetadataPatch", () => {
  it("clears a previous PR when the current branch has no PR", () => {
    expect(
      deriveThreadGitMetadataPatch({
        currentBranch: pullRequest.headBranch,
        currentPullRequest: pullRequest,
        observedBranch: pullRequest.headBranch,
        pullRequestLookup: { status: "resolved", pullRequest: null },
      }),
    ).toEqual({ lastKnownPr: null });
  });

  it("clears a stale PR when the branch changes while GitHub is unavailable", () => {
    expect(
      deriveThreadGitMetadataPatch({
        currentBranch: pullRequest.headBranch,
        currentPullRequest: pullRequest,
        observedBranch: "feat/next-change",
        pullRequestLookup: { status: "unavailable" },
      }),
    ).toEqual({ branch: "feat/next-change", lastKnownPr: null });
  });

  it("clears branch and PR for detached HEAD", () => {
    expect(
      deriveThreadGitMetadataPatch({
        currentBranch: pullRequest.headBranch,
        currentPullRequest: pullRequest,
        observedBranch: null,
        pullRequestLookup: { status: "resolved", pullRequest: null },
      }),
    ).toEqual({ branch: null, lastKnownPr: null });
  });

  it("does not regress a semantic branch to a temporary worktree branch", () => {
    expect(
      deriveThreadGitMetadataPatch({
        currentBranch: pullRequest.headBranch,
        currentPullRequest: pullRequest,
        observedBranch: "synara/deadbeef",
        pullRequestLookup: { status: "resolved", pullRequest: null },
      }),
    ).toBeNull();
  });

  it("does not emit an event when persisted metadata already matches", () => {
    expect(
      deriveThreadGitMetadataPatch({
        currentBranch: pullRequest.headBranch,
        currentPullRequest: pullRequest,
        observedBranch: pullRequest.headBranch,
        pullRequestLookup: { status: "resolved", pullRequest: { ...pullRequest } },
      }),
    ).toBeNull();
  });

  it("repairs stale associated worktree identity without changing matching branch metadata", () => {
    expect(
      deriveThreadGitMetadataPatch({
        currentBranch: pullRequest.headBranch,
        currentPullRequest: pullRequest,
        observedBranch: pullRequest.headBranch,
        pullRequestLookup: { status: "resolved", pullRequest },
        dedicatedWorktree: {
          cwd: "/repo/.worktrees/thread",
          currentPath: "/repo/.worktrees/thread",
          currentBranch: "synara/stale-branch",
        },
      }),
    ).toEqual({
      associatedWorktreeBranch: pullRequest.headBranch,
      associatedWorktreeRef: pullRequest.headBranch,
    });
  });
});
