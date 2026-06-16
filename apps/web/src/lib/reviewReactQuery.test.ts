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
        baseBranch: " main ",
        headBranch: " feature/review-board ",
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
        baseBranch: "main",
        headBranch: "feature/review-board",
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
        baseBranch: " main ",
        headBranch: " feature/review-board ",
        columns: ["approved", "needs-review", "approved"],
        checks: ["pending", "passing", "pending"],
      }),
    ).toEqual({
      cwd: "/repo",
      search: "review board",
      author: "alice",
      baseBranch: "main",
      headBranch: "feature/review-board",
      columns: ["approved", "needs-review"],
      checks: ["passing", "pending"],
    });
  });
});
