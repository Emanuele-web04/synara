import { describe, expect, it } from "vitest";
import type { GitBranch, GitPullRequestListItem } from "@synara/contracts";

import {
  branchNameFromWorkspaceTitle,
  dedupeWorkspaceBranches,
  filterWorkspaceBranches,
  filterWorkspacePullRequests,
} from "./WorktreeWorkspaceCreateDialog.logic";

const branches: GitBranch[] = [
  {
    name: "main",
    current: true,
    isDefault: true,
    worktreePath: "/repo",
  },
  {
    name: "origin/main",
    isRemote: true,
    remoteName: "origin",
    current: false,
    isDefault: true,
    worktreePath: null,
  },
  {
    name: "origin/feature/searchable-picker",
    isRemote: true,
    remoteName: "origin",
    current: false,
    isDefault: false,
    worktreePath: null,
  },
];

const pullRequests: GitPullRequestListItem[] = [
  {
    number: 42,
    title: "Make branch search reliable",
    url: "https://github.com/example/repo/pull/42",
    baseBranch: "main",
    headBranch: "feature/searchable-picker",
    state: "open",
    isDraft: false,
    authorLogin: "octocat",
    authorAvatarUrl: null,
    updatedAt: "2026-07-14T12:00:00Z",
    additions: 47,
    deletions: 19,
  },
  {
    number: 77,
    title: "Close legacy setup",
    url: "https://github.com/example/repo/pull/77",
    baseBranch: "release",
    headBranch: "cleanup/legacy",
    state: "closed",
    isDraft: false,
    authorLogin: "hubot",
    authorAvatarUrl: null,
    updatedAt: null,
    additions: null,
    deletions: null,
  },
];

describe("workspace source filtering", () => {
  it("derives an editable branch name from the workspace title", () => {
    expect(branchNameFromWorkspaceTitle("  Review checkout flow  ")).toBe(
      "synara/review-checkout-flow",
    );
  });

  it("deduplicates a local branch and its matching remote branch", () => {
    expect(dedupeWorkspaceBranches(branches).map((branch) => branch.name)).toEqual([
      "main",
      "origin/feature/searchable-picker",
    ]);
  });

  it("searches readable and fully qualified branch names", () => {
    expect(filterWorkspaceBranches(dedupeWorkspaceBranches(branches), "searchable")).toEqual([
      branches[2],
    ]);
    expect(filterWorkspaceBranches(dedupeWorkspaceBranches(branches), "origin/feature")).toEqual([
      branches[2],
    ]);
  });

  it("searches pull requests by title, author, head/base branch, URL, and number", () => {
    expect(filterWorkspacePullRequests(pullRequests, "octocat")).toEqual([pullRequests[0]]);
    expect(filterWorkspacePullRequests(pullRequests, "cleanup/legacy")).toEqual([pullRequests[1]]);
    expect(filterWorkspacePullRequests(pullRequests, "#42")).toEqual([pullRequests[0]]);
    expect(filterWorkspacePullRequests(pullRequests, "release")).toEqual([pullRequests[1]]);
    expect(filterWorkspacePullRequests(pullRequests, "github.com/example/repo/pull/77")).toEqual([
      pullRequests[1],
    ]);
  });
});
