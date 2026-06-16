import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type {
  ReviewChangesetResult,
  ReviewConversationResult,
  ReviewPullRequestOverview,
  ReviewPullRequestSurfaceInput,
  ReviewPullRequestSurfaceResult,
  ReviewSourceRef,
} from "@t3tools/contracts";

import {
  applyReviewPullRequestSurfacePayload,
  buildReviewListPullRequestsRequest,
  reviewQueryKeys,
  reviewSourceKey,
} from "./reviewReactQuery";

const REVIEW_SOURCE = { _tag: "pullRequest", reference: "42" } satisfies ReviewSourceRef;
const REVIEW_OVERVIEW = {
  detail: {
    number: 42,
    title: "Review loading",
    url: "https://github.com/acme/demo/pull/42",
    state: "open",
    isDraft: false,
    author: "alice",
    baseBranch: "main",
    headBranch: "feature/review-loading",
    body: "Body",
    createdAt: "2026-06-16T12:00:00Z",
    updatedAt: "2026-06-16T12:00:00Z",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    commitsCount: 1,
    reviewDecision: null,
    mergeable: "MERGEABLE",
    checksStatus: "passing",
    milestone: null,
    labels: [],
    assignees: [],
    reviewers: [],
  },
  commits: [],
  checks: [],
} satisfies ReviewPullRequestOverview;
const REVIEW_CONVERSATION = { events: [] } satisfies ReviewConversationResult;
const REVIEW_CHANGESET = {
  target: { _tag: "pullRequest", repositoryId: "repo", number: 42 },
  patch: "diff --git a/a.ts b/a.ts\n",
  files: [],
} satisfies ReviewChangesetResult;

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

  it("separates distinct search terms into distinct list cache keys", () => {
    expect(reviewQueryKeys.pullRequests({ cwd: "/repo" })).not.toEqual(
      reviewQueryKeys.pullRequests({ cwd: "/repo", search: "body-only-match" }),
    );
    expect(
      reviewQueryKeys.pullRequests({ cwd: "/repo", search: "body-only-match" }),
    ).not.toEqual(reviewQueryKeys.pullRequests({ cwd: "/repo", search: "other" }));
  });

  it("separates non-default sort modes into distinct list cache keys", () => {
    expect(reviewQueryKeys.pullRequests({ cwd: "/repo" })).not.toEqual(
      reviewQueryKeys.pullRequests({ cwd: "/repo", sort: "title" }),
    );
    expect(reviewQueryKeys.pullRequests({ cwd: "/repo", sort: "title" })).not.toEqual(
      reviewQueryKeys.pullRequests({ cwd: "/repo", sort: "size" }),
    );
  });
});

describe("reviewQueryKeys.pullRequestSurface", () => {
  it("separates aggregate surface keys by source and requested pieces", () => {
    expect(
      reviewQueryKeys.pullRequestSurface(
        "/repo",
        "42",
        reviewSourceKey(REVIEW_SOURCE),
        true,
        false,
      ),
    ).not.toEqual(
      reviewQueryKeys.pullRequestSurface(
        "/repo",
        "42",
        reviewSourceKey(REVIEW_SOURCE),
        false,
        true,
      ),
    );
  });
});

describe("reviewQueryKeys.pullRequestHeader", () => {
  it("keeps lightweight header cache separate from the full overview cache", () => {
    expect(reviewQueryKeys.pullRequestHeader("/repo", "42")).not.toEqual(
      reviewQueryKeys.pullRequest("/repo", "42"),
    );
  });
});

describe("applyReviewPullRequestSurfacePayload", () => {
  it("primes the existing overview conversation and changeset cache entries", () => {
    const queryClient = new QueryClient();
    const input = {
      cwd: "/repo",
      reference: "42",
      source: REVIEW_SOURCE,
      includeConversation: true,
      includeChangeset: true,
    } satisfies ReviewPullRequestSurfaceInput;
    const payload = {
      overview: REVIEW_OVERVIEW,
      conversation: REVIEW_CONVERSATION,
      changeset: REVIEW_CHANGESET,
    } satisfies ReviewPullRequestSurfaceResult;

    applyReviewPullRequestSurfacePayload(queryClient, input, payload);

    expect(queryClient.getQueryData(reviewQueryKeys.pullRequest("/repo", "42"))).toBe(
      REVIEW_OVERVIEW,
    );
    expect(queryClient.getQueryData(reviewQueryKeys.conversation("/repo", "42"))).toBe(
      REVIEW_CONVERSATION,
    );
    expect(
      queryClient.getQueryData(reviewQueryKeys.changeset("/repo", reviewSourceKey(REVIEW_SOURCE))),
    ).toBe(REVIEW_CHANGESET);
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
        sort: "size",
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
      sort: "size",
    });
  });
});
