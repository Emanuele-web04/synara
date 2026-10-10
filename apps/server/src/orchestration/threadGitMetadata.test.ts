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

const dedicatedWorktree = {
  cwd: "/repo/.worktrees/thread",
  currentPath: "/repo/.worktrees/thread",
  currentBranch: pullRequest.headBranch,
};

const otherPullRequest: OrchestrationThreadPullRequest = {
  ...pullRequest,
  number: 575,
  url: "https://github.com/Emanuele-web04/synara/pull/575",
  headBranch: "feat/next-change",
};

describe("deriveThreadGitMetadataPatch", () => {
  it("clears a previous PR when the current branch has no PR", () => {
    expect(
      deriveThreadGitMetadataPatch({
        currentBranch: pullRequest.headBranch,
        currentPullRequest: pullRequest,
        observedBranch: pullRequest.headBranch,
        pullRequestLookup: { status: "resolved", pullRequest: null },
        dedicatedWorktree,
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
        dedicatedWorktree,
      }),
    ).toEqual({
      branch: "feat/next-change",
      lastKnownPr: null,
      associatedWorktreeBranch: "feat/next-change",
      associatedWorktreeRef: "feat/next-change",
    });
  });

  it("clears branch and PR for detached HEAD", () => {
    expect(
      deriveThreadGitMetadataPatch({
        currentBranch: pullRequest.headBranch,
        currentPullRequest: pullRequest,
        observedBranch: null,
        pullRequestLookup: { status: "resolved", pullRequest: null },
        dedicatedWorktree,
      }),
    ).toEqual({ branch: null, lastKnownPr: null });
  });

  it.each([
    {
      name: "the observed branch has no PR",
      observedBranch: "main",
      pullRequestLookup: { status: "resolved", pullRequest: null },
      expected: { branch: "main" },
    },
    {
      name: "the branch changes while GitHub is unavailable",
      observedBranch: "main",
      pullRequestLookup: { status: "unavailable" },
      expected: { branch: "main" },
    },
    {
      name: "HEAD is detached",
      observedBranch: null,
      pullRequestLookup: { status: "resolved", pullRequest: null },
      expected: { branch: null },
    },
  ] as const)("keeps a shared checkout's PR when $name", (testCase) => {
    expect(
      deriveThreadGitMetadataPatch({
        currentBranch: pullRequest.headBranch,
        currentPullRequest: pullRequest,
        observedBranch: testCase.observedBranch,
        pullRequestLookup: testCase.pullRequestLookup,
      }),
    ).toEqual(testCase.expected);
  });

  it("replaces a shared checkout's PR when the observed branch has its own PR", () => {
    expect(
      deriveThreadGitMetadataPatch({
        currentBranch: pullRequest.headBranch,
        currentPullRequest: pullRequest,
        observedBranch: otherPullRequest.headBranch,
        pullRequestLookup: { status: "resolved", pullRequest: otherPullRequest },
      }),
    ).toEqual({ branch: otherPullRequest.headBranch, lastKnownPr: otherPullRequest });
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
