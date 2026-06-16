import { describe, expect, it } from "vitest";

import { buildReviewListPullRequestsRequest, reviewQueryKeys } from "./reviewReactQuery";

describe("reviewQueryKeys.pullRequests", () => {
  it("normalizes equivalent server-side filter values into the same cache key", () => {
    expect(
      reviewQueryKeys.pullRequests({
        cwd: "/repo",
        state: "open",
        limit: 25,
        search: " review board ",
        author: "alice",
        authors: [" bob ", "alice", "bob"],
        baseBranch: " main ",
        baseBranches: [" release ", "main", "release"],
        headBranch: " feature/review-board ",
        headBranches: [" octocat:feature/review-board ", "feature/review-board"],
        label: " bug ",
        labels: [" feature ", "bug", "feature"],
        assignee: " alice ",
        assignees: [" bob ", "alice", "bob"],
        draft: true,
        columns: ["approved", "needs-review"],
        checks: ["pending", "passing"],
      }),
    ).toEqual(
      reviewQueryKeys.pullRequests({
        cwd: "/repo",
        state: "open",
        limit: 25,
        search: "review board",
        author: "alice",
        authors: ["alice", "bob"],
        baseBranch: "main",
        baseBranches: ["main", "release"],
        headBranch: "feature/review-board",
        headBranches: ["feature/review-board", "octocat:feature/review-board"],
        label: "bug",
        labels: ["bug", "feature"],
        assignee: "alice",
        assignees: ["alice", "bob"],
        draft: true,
        columns: ["needs-review", "approved"],
        checks: ["passing", "pending"],
      }),
    );
  });

  it("nests filtered list keys under the pull request list prefix", () => {
    const key = reviewQueryKeys.pullRequests({
      cwd: "/repo",
      state: "open",
      search: "review board",
    });
    expect(key.slice(0, 3)).toEqual(reviewQueryKeys.pullRequestLists("/repo"));
  });
});

describe("buildReviewListPullRequestsRequest", () => {
  it("canonicalizes filtered list query payloads", () => {
    expect(
      buildReviewListPullRequestsRequest({
        cwd: "/repo",
        search: " review board ",
        author: " alice ",
        authors: [" bob ", "alice", "bob"],
        baseBranch: " main ",
        baseBranches: [" release ", "main", "release"],
        headBranch: " feature/review-board ",
        headBranches: [" octocat:feature/review-board ", "feature/review-board"],
        label: " bug ",
        labels: [" feature ", "bug", "feature"],
        assignee: " alice ",
        assignees: [" bob ", "alice", "bob"],
        draft: true,
        columns: ["approved", "needs-review", "approved"],
        checks: ["pending", "passing", "pending"],
      }),
    ).toEqual({
      cwd: "/repo",
      search: "review board",
      author: "alice",
      authors: ["alice", "bob"],
      baseBranch: "main",
      baseBranches: ["main", "release"],
      headBranch: "feature/review-board",
      headBranches: ["feature/review-board", "octocat:feature/review-board"],
      label: "bug",
      labels: ["bug", "feature"],
      assignee: "alice",
      assignees: ["alice", "bob"],
      draft: true,
      columns: ["approved", "needs-review"],
      checks: ["passing", "pending"],
    });
  });
});
