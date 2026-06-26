import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type {
  ReviewChangesetResult,
  ReviewConversationResult,
  ReviewPullRequestOverview,
  ReviewPullRequestSurfaceInput,
  ReviewPullRequestSurfaceResult,
  ReviewSourceRef,
  ReviewWalkthrough,
} from "@t3tools/contracts";

import {
  applyReviewPullRequestSurfacePayload,
  applyReviewUpdatedPayload,
  buildReviewListPullRequestsRequest,
  reviewGenerateWalkthroughQueryOptions,
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
const REVIEW_WALKTHROUGH = {
  prologue: {
    motivation: "Make the walkthrough durable.",
    outcome: "Reviewers can return without regenerating it.",
    keyChanges: [
      {
        summary: "Cache generated walkthrough",
        description: "Store the generated walkthrough result under the current patch signature.",
      },
    ],
    focusAreas: [],
    complexity: { level: "low", reasoning: "Single generated artifact." },
  },
  chapters: [
    {
      id: "chapter-cache",
      title: "Cache walkthrough output",
      summary: "Persist generated walkthrough data.",
      intent: "Avoid rerunning the generation flow after navigation.",
      anchor: "review cache",
      risk: "minor",
      hunkRefs: [{ filePath: "apps/server/src/review/Layers/ReviewSource.ts", oldStart: 1 }],
      files: ["apps/server/src/review/Layers/ReviewSource.ts"],
      status: "active",
    },
  ],
  reviewedHeadSha: "head-sha-1",
  patchSignature: "patch-sig-1",
  patchSource: "github",
  generatedAt: "2026-06-16T00:00:00.000Z",
} satisfies ReviewWalkthrough;

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
    expect(reviewQueryKeys.pullRequests({ cwd: "/repo", search: "body-only-match" })).not.toEqual(
      reviewQueryKeys.pullRequests({ cwd: "/repo", search: "other" }),
    );
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
    expect(queryClient.getQueryData(reviewQueryKeys.pullRequestHeader("/repo", "42"))).toEqual({
      detail: REVIEW_OVERVIEW.detail,
    });
    expect(queryClient.getQueryData(reviewQueryKeys.conversation("/repo", "42"))).toBe(
      REVIEW_CONVERSATION,
    );
    expect(
      queryClient.getQueryData(reviewQueryKeys.changeset("/repo", reviewSourceKey(REVIEW_SOURCE))),
    ).toBe(REVIEW_CHANGESET);
  });
});

describe("applyReviewUpdatedPayload", () => {
  it("primes the lightweight header cache when an overview update arrives", () => {
    const queryClient = new QueryClient();

    applyReviewUpdatedPayload(queryClient, {
      _tag: "pullRequestOverview",
      cwd: "/repo",
      repositoryId: "repo",
      reference: "42",
      data: REVIEW_OVERVIEW,
      fetchedAt: 123,
    });

    expect(queryClient.getQueryData(reviewQueryKeys.pullRequest("/repo", "42"))).toBe(
      REVIEW_OVERVIEW,
    );
    expect(queryClient.getQueryData(reviewQueryKeys.pullRequestHeader("/repo", "42"))).toEqual({
      detail: REVIEW_OVERVIEW.detail,
    });
  });

  it("invalidates board-lane and list queries for the repo on a boardLanes signal", () => {
    const queryClient = new QueryClient();
    const laneKey = reviewQueryKeys.boardLanes("/repo");
    const listKey = reviewQueryKeys.pullRequests({ cwd: "/repo" });
    queryClient.setQueryData(laneKey, {
      "needs-review": { pullRequests: [] },
      "changes-requested": { pullRequests: [] },
      approved: { pullRequests: [] },
      draft: { pullRequests: [] },
    });
    queryClient.setQueryData(listKey, { pullRequests: [] });
    expect(queryClient.getQueryState(laneKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(false);

    applyReviewUpdatedPayload(queryClient, {
      _tag: "boardLanes",
      cwd: "/repo",
      repositoryId: "repo",
      fetchedAt: 123,
    });

    expect(queryClient.getQueryState(laneKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
  });

  it("hydrates walkthrough updates with the query result shape", () => {
    const queryClient = new QueryClient();

    applyReviewUpdatedPayload(queryClient, {
      _tag: "pullRequestWalkthrough",
      cwd: "/repo",
      repositoryId: "repo",
      reference: "42",
      data: REVIEW_WALKTHROUGH,
      fetchedAt: 123,
    });

    expect(
      queryClient.getQueryData(
        reviewQueryKeys.walkthrough("/repo", "42", "patch-sig-1", "head-sha-1"),
      ),
    ).toEqual({
      walkthrough: REVIEW_WALKTHROUGH,
      reviewedHeadSha: "head-sha-1",
      patchSignature: "patch-sig-1",
      patchSource: "github",
      headMoved: false,
      patchChanged: false,
    });
  });

  it("hydrates active walkthrough queries with generation settings", () => {
    const queryClient = new QueryClient();
    const settingsKey = reviewQueryKeys.walkthrough("/repo", "42", "patch-sig-1", "head-sha-1", {
      textGenerationModel: "openai/gpt-5",
    });
    queryClient.setQueryData(settingsKey, {
      walkthrough: REVIEW_WALKTHROUGH,
      reviewedHeadSha: "head-sha-1",
      patchSignature: "patch-sig-1",
      patchSource: "github",
      headMoved: false,
      patchChanged: false,
    });

    applyReviewUpdatedPayload(queryClient, {
      _tag: "pullRequestWalkthrough",
      cwd: "/repo",
      repositoryId: "repo",
      reference: "42",
      data: REVIEW_WALKTHROUGH,
      fetchedAt: 123,
    });

    expect(queryClient.getQueryData(settingsKey)).toEqual({
      walkthrough: REVIEW_WALKTHROUGH,
      reviewedHeadSha: "head-sha-1",
      patchSignature: "patch-sig-1",
      patchSource: "github",
      headMoved: false,
      patchChanged: false,
    });
  });
});

describe("reviewGenerateWalkthroughQueryOptions", () => {
  it("keeps generated walkthroughs in memory long enough for review tab switching", () => {
    const options = reviewGenerateWalkthroughQueryOptions({
      cwd: "/repo",
      reference: "42",
      source: REVIEW_SOURCE,
      patchSignature: "patch-sig-1",
      expectedHeadSha: "head-sha-1",
    });

    expect(options.staleTime).toBe(Infinity);
    expect(options.gcTime).toBe(60 * 60_000);
  });

  it("keys walkthrough results by generation settings", () => {
    const baseOptions = reviewGenerateWalkthroughQueryOptions({
      cwd: "/repo",
      reference: "42",
      source: REVIEW_SOURCE,
      patchSignature: "patch-sig-1",
      expectedHeadSha: "head-sha-1",
      textGenerationModel: "gpt-5.4-mini",
    });
    const changedOptions = reviewGenerateWalkthroughQueryOptions({
      cwd: "/repo",
      reference: "42",
      source: REVIEW_SOURCE,
      patchSignature: "patch-sig-1",
      expectedHeadSha: "head-sha-1",
      textGenerationModel: "openai/gpt-5",
    });

    expect(changedOptions.queryKey).not.toEqual(baseOptions.queryKey);
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
