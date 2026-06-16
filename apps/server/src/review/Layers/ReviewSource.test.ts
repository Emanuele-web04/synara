import { it } from "@effect/vitest";
import type {
  ReviewListPullRequestsResult,
  ReviewPullRequestSummary,
  ReviewUpdatedPayload,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Stream } from "effect";
import { expect } from "vitest";

import { GitHubCliError } from "../../git/Errors.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import {
  GitHubCli,
  type GitHubCliShape,
  type GitHubReviewPullRequest,
} from "../../git/Services/GitHubCli.ts";
import { GitManager, type GitManagerShape } from "../../git/Services/GitManager.ts";
import { TextGeneration, type TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import {
  type ReviewCacheEnvelope,
  ReviewCacheStore,
  type ReviewCacheStoreShape,
  type ReviewCacheWrite,
} from "../Services/ReviewCacheStore.ts";
import { ReviewSource } from "../Services/ReviewSource.ts";
import { ReviewUpdateBus } from "../Services/ReviewUpdateBus.ts";
import { ReviewSourceLive } from "./ReviewSource.ts";

interface RecordedListCall {
  readonly cwd: string;
  readonly state: "open" | "closed" | "merged" | "all";
  readonly limit?: number;
  readonly search?: string;
  readonly author?: string;
  readonly reviewRequested?: string;
  readonly baseBranch?: string;
  readonly headBranch?: string;
  readonly label?: string;
  readonly assignee?: string;
  readonly draft?: boolean;
}

interface RecordedCacheWrite {
  readonly repositoryId: string;
  readonly listFilter: string;
  readonly data: ReviewListPullRequestsResult;
  readonly tokenIdentity: string;
}

function unexpected(method: string): never {
  throw new Error(`Unexpected ReviewSource test call: ${method}`);
}

function unexpectedEffect(method: string): Effect.Effect<never> {
  return Effect.die(new Error(`Unexpected ReviewSource test call: ${method}`));
}

function ghPr(
  overrides: Partial<GitHubReviewPullRequest> & { readonly number: number },
): GitHubReviewPullRequest {
  return {
    number: overrides.number,
    title: "Pull request",
    url: `https://github.com/acme/demo/pull/${String(overrides.number)}`,
    baseRefName: "main",
    headRefName: `branch-${String(overrides.number)}`,
    author: "alice",
    updatedAt: "2026-06-16T00:00:00.000Z",
    state: "open",
    reviewDecision: null,
    isDraft: false,
    additions: 1,
    deletions: 0,
    checksStatus: "pending",
    reviewRequests: [],
    labels: [],
    assignees: [],
    ...overrides,
  };
}

function makeLayer(options: {
  readonly pullRequests: ReadonlyArray<GitHubReviewPullRequest>;
  readonly viewerLogin?: string;
}) {
  const recorded = {
    listCalls: [] as RecordedListCall[],
    cacheWrites: [] as RecordedCacheWrite[],
    published: [] as ReviewUpdatedPayload[],
  };

  const gitHubCli: GitHubCliShape = {
    getAuthenticatedUser: () =>
      Effect.succeed({ login: options.viewerLogin ?? "tyler", avatarUrl: "https://avatar.test" }),
    listRepositoryPullRequests: (input) => {
      recorded.listCalls.push(input);
      const limit = input.limit ?? options.pullRequests.length;
      return Effect.succeed(options.pullRequests.slice(0, limit));
    },
    execute: () => unexpected("GitHubCli.execute"),
    listOpenPullRequests: () => unexpected("GitHubCli.listOpenPullRequests"),
    getPullRequest: () => unexpected("GitHubCli.getPullRequest"),
    getReviewPullRequestOverview: () =>
      Effect.fail(new GitHubCliError({ operation: "test", detail: "unexpected overview" })),
    getReviewConversation: () =>
      Effect.fail(new GitHubCliError({ operation: "test", detail: "unexpected conversation" })),
    getPullRequestDiff: () => unexpected("GitHubCli.getPullRequestDiff"),
    getPullRequestHeadSha: () => unexpected("GitHubCli.getPullRequestHeadSha"),
    submitPullRequestReview: () => unexpected("GitHubCli.submitPullRequestReview"),
    createPullRequestReviewWithComments: () =>
      unexpected("GitHubCli.createPullRequestReviewWithComments"),
    getPullRequestThreads: () => unexpected("GitHubCli.getPullRequestThreads"),
    getRepositoryCloneUrls: () => unexpected("GitHubCli.getRepositoryCloneUrls"),
    createPullRequest: () => unexpected("GitHubCli.createPullRequest"),
    getDefaultBranch: () => unexpected("GitHubCli.getDefaultBranch"),
    checkoutPullRequest: () => unexpected("GitHubCli.checkoutPullRequest"),
    projectScopeAvailable: () => unexpected("GitHubCli.projectScopeAvailable"),
    listProjects: () => unexpected("GitHubCli.listProjects"),
    getProjectBoard: () => unexpected("GitHubCli.getProjectBoard"),
    moveProjectCard: () => unexpected("GitHubCli.moveProjectCard"),
    getRepositoryOwner: () => unexpected("GitHubCli.getRepositoryOwner"),
  };

  const gitCore: GitCoreShape = {
    execute: () =>
      Effect.succeed({
        code: 0,
        stdout: "/repo\n",
        stderr: "",
      }),
    status: () => unexpectedEffect("GitCore.status"),
    statusDetails: () => unexpectedEffect("GitCore.statusDetails"),
    readWorkingTreePatch: () => unexpectedEffect("GitCore.readWorkingTreePatch"),
    readUnstagedPatch: () => unexpectedEffect("GitCore.readUnstagedPatch"),
    readStagedPatch: () => unexpectedEffect("GitCore.readStagedPatch"),
    readBranchPatch: () => unexpectedEffect("GitCore.readBranchPatch"),
    prepareCommitContext: () => unexpectedEffect("GitCore.prepareCommitContext"),
    commit: () => unexpectedEffect("GitCore.commit"),
    pushCurrentBranch: () => unexpectedEffect("GitCore.pushCurrentBranch"),
    readRangeContext: () => unexpectedEffect("GitCore.readRangeContext"),
    readRangeDiff: () => unexpectedEffect("GitCore.readRangeDiff"),
    readConfigValue: () => unexpectedEffect("GitCore.readConfigValue"),
    listBranches: () => unexpectedEffect("GitCore.listBranches"),
    pullCurrentBranch: () => unexpectedEffect("GitCore.pullCurrentBranch"),
    createWorktree: () => unexpectedEffect("GitCore.createWorktree"),
    createDetachedWorktree: () => unexpectedEffect("GitCore.createDetachedWorktree"),
    fetchPullRequestBranch: () => unexpectedEffect("GitCore.fetchPullRequestBranch"),
    ensureRemote: () => unexpectedEffect("GitCore.ensureRemote"),
    fetchRemoteBranch: () => unexpectedEffect("GitCore.fetchRemoteBranch"),
    setBranchUpstream: () => unexpectedEffect("GitCore.setBranchUpstream"),
    removeWorktree: () => unexpectedEffect("GitCore.removeWorktree"),
    renameBranch: () => unexpectedEffect("GitCore.renameBranch"),
    createBranch: () => unexpectedEffect("GitCore.createBranch"),
    publishBranch: () => unexpectedEffect("GitCore.publishBranch"),
    checkoutBranch: () => unexpectedEffect("GitCore.checkoutBranch"),
    stashAndCheckout: () => unexpectedEffect("GitCore.stashAndCheckout"),
    stashDrop: () => unexpectedEffect("GitCore.stashDrop"),
    stashInfo: () => unexpectedEffect("GitCore.stashInfo"),
    removeIndexLock: () => unexpectedEffect("GitCore.removeIndexLock"),
    initRepo: () => unexpectedEffect("GitCore.initRepo"),
    listLocalBranchNames: () => unexpectedEffect("GitCore.listLocalBranchNames"),
    stageFiles: () => unexpectedEffect("GitCore.stageFiles"),
    unstageFiles: () => unexpectedEffect("GitCore.unstageFiles"),
  };

  const cacheStore: ReviewCacheStoreShape = {
    getPullRequestList: (input) => {
      const write = recorded.cacheWrites.find(
        (entry) => entry.repositoryId === input.repositoryId && entry.listFilter === input.listFilter,
      );
      if (!write) {
        return Effect.succeed(Option.none());
      }
      return Effect.succeed(
        Option.some({
          data: write.data,
          fetchedAt: Date.now(),
          lastValidatedAt: Date.now(),
          ttlMs: 30_000,
          etag: null,
          lastModified: null,
          tokenIdentity: write.tokenIdentity,
          headSha: null,
        } satisfies ReviewCacheEnvelope<ReviewListPullRequestsResult>),
      );
    },
    upsertPullRequestList: (input: ReviewCacheWrite<ReviewListPullRequestsResult> & {
      readonly listFilter: string;
    }) => {
      recorded.cacheWrites.push({
        repositoryId: input.repositoryId,
        listFilter: input.listFilter,
        data: input.data,
        tokenIdentity: input.tokenIdentity,
      });
      return Effect.void;
    },
    getPullRequestOverview: () => unexpected("ReviewCacheStore.getPullRequestOverview"),
    upsertPullRequestOverview: () => unexpected("ReviewCacheStore.upsertPullRequestOverview"),
    getPullRequestConversation: () => unexpected("ReviewCacheStore.getPullRequestConversation"),
    upsertPullRequestConversation: () =>
      unexpected("ReviewCacheStore.upsertPullRequestConversation"),
    getPullRequestChangeset: () => unexpected("ReviewCacheStore.getPullRequestChangeset"),
    upsertPullRequestChangeset: () => unexpected("ReviewCacheStore.upsertPullRequestChangeset"),
  };

  const gitManager: GitManagerShape = {
    status: () => unexpectedEffect("GitManager.status"),
    readWorkingTreeDiff: () => unexpectedEffect("GitManager.readWorkingTreeDiff"),
    summarizeDiff: () => unexpectedEffect("GitManager.summarizeDiff"),
    resolvePullRequest: () => unexpectedEffect("GitManager.resolvePullRequest"),
    preparePullRequestThread: () => unexpectedEffect("GitManager.preparePullRequestThread"),
    handoffThread: () => unexpectedEffect("GitManager.handoffThread"),
    runStackedAction: () => unexpectedEffect("GitManager.runStackedAction"),
  };

  const textGeneration: TextGenerationShape = {
    generateCommitMessage: () => unexpectedEffect("TextGeneration.generateCommitMessage"),
    generatePrContent: () => unexpectedEffect("TextGeneration.generatePrContent"),
    generateDiffSummary: () => unexpectedEffect("TextGeneration.generateDiffSummary"),
    generateReviewFindings: () => unexpectedEffect("TextGeneration.generateReviewFindings"),
    generateBranchName: () => unexpectedEffect("TextGeneration.generateBranchName"),
    generateThreadTitle: () => unexpectedEffect("TextGeneration.generateThreadTitle"),
    generateThreadRecap: () => unexpectedEffect("TextGeneration.generateThreadRecap"),
  };

  const depsLayer = Layer.mergeAll(
    Layer.succeed(GitHubCli, gitHubCli),
    Layer.succeed(GitCore, gitCore),
    Layer.succeed(GitManager, gitManager),
    Layer.succeed(TextGeneration, textGeneration),
    Layer.succeed(ReviewCacheStore, cacheStore),
    Layer.succeed(ReviewUpdateBus, {
      publish: (payload: ReviewUpdatedPayload) => {
        recorded.published.push(payload);
        return Effect.void;
      },
      stream: Stream.empty,
    }),
  );

  return {
    layer: ReviewSourceLive.pipe(Layer.provide(depsLayer)),
    recorded,
  };
}

const runList = (
  layer: Layer.Layer<ReviewSource>,
  input: Parameters<ReviewSource["listPullRequests"]>[0],
) =>
  Effect.gen(function* () {
    const reviewSource = yield* ReviewSource;
    return yield* reviewSource.listPullRequests(input);
  }).pipe(Effect.provide(layer));

function numbers(result: ReviewListPullRequestsResult): number[] {
  return result.pullRequests.map((pullRequest: ReviewPullRequestSummary) => pullRequest.number);
}

it.effect("pushes text search to GitHub and caches the normalized filter key", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [
      ghPr({ number: 1, title: "Speed up review board" }),
      ghPr({ number: 2, title: "Speed up review board", baseRefName: "release" }),
      ghPr({ number: 3, title: "Speed up review board", headRefName: "feature/other" }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      search: "review board",
      baseBranch: "main",
      headBranch: "branch-1",
      limit: 25,
    });

    expect(numbers(result)).toEqual([1]);
    expect(result.meta).toEqual({
      requestedLimit: 25,
      resultLimit: 25,
      candidateLimit: 25,
      candidateCount: 3,
      candidateLimitReached: false,
      matchedCount: 1,
      returnedCount: 1,
      bounded: true,
    });
    expect(recorded.listCalls).toEqual([
      {
        cwd: "/repo",
        state: "open",
        limit: 25,
        search: "review board",
        baseBranch: "main",
        headBranch: "branch-1",
      },
    ]);
    expect(JSON.parse(recorded.cacheWrites[0]?.listFilter ?? "{}")).toEqual({
      state: "open",
      limit: 25,
      search: "review board",
      author: null,
      reviewRequested: null,
      baseBranch: "main",
      headBranch: "branch-1",
      label: null,
      assignee: null,
      draft: null,
      columns: [],
      checks: [],
    });
  });
});

it.effect("keeps owner-qualified head selectors distinct for fork pull requests", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [
      ghPr({ number: 1, title: "Fork one", headRefName: "feature/shared" }),
      ghPr({
        number: 2,
        title: "Fork two",
        headRefName: "feature/shared",
        headRepositoryOwnerLogin: "octocat",
      }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      headBranch: "octocat:feature/shared",
    });

    expect(result.pullRequests).toMatchObject([
      {
        number: 2,
        headBranch: "feature/shared",
        headSelector: "octocat:feature/shared",
      },
    ]);
    expect(recorded.listCalls).toEqual([
      {
        cwd: "/repo",
        state: "open",
        limit: 50,
        headBranch: "octocat:feature/shared",
      },
    ]);
  });
});

it.effect("keeps branch, URL, and reviewer matches returned by GitHub search", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [
      ghPr({ number: 1, title: "Branch match", headRefName: "feature/search-panel" }),
      ghPr({ number: 2, title: "URL match", url: "https://github.com/acme/demo/pull/221" }),
      ghPr({ number: 3, title: "Reviewer match", reviewRequests: ["tyler"] }),
      ghPr({ number: 4, title: "Unrelated" }),
    ],
  });

  return Effect.gen(function* () {
    const branchResult = yield* runList(layer, {
      cwd: "/repo",
      search: "search-panel",
    });
    const urlResult = yield* runList(layer, {
      cwd: "/repo",
      search: "pull/221",
    });
    const reviewerResult = yield* runList(layer, {
      cwd: "/repo",
      search: "tyler",
    });

    expect(numbers(branchResult)).toEqual([1]);
    expect(numbers(urlResult)).toEqual([2]);
    expect(numbers(reviewerResult)).toEqual([3]);
    expect(recorded.listCalls).toEqual([
      { cwd: "/repo", state: "open", limit: 50, search: "search-panel" },
      { cwd: "/repo", state: "open", limit: 50, search: "pull/221" },
      { cwd: "/repo", state: "open", limit: 50, search: "tyler" },
    ]);
  });
});

it.effect("uses a larger bounded candidate window for local-only status and check filters", () => {
  const pullRequests = Array.from({ length: 120 }, (_, index) =>
    ghPr({
      number: index + 1,
      reviewDecision: index % 2 === 0 ? "APPROVED" : null,
      checksStatus: index % 2 === 0 ? "failing" : "passing",
    }),
  );
  const { layer, recorded } = makeLayer({ pullRequests });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      limit: 200,
      columns: ["approved"],
      checks: ["failing"],
    });

    expect(numbers(result)).toHaveLength(60);
    expect(result.meta).toEqual({
      requestedLimit: 200,
      resultLimit: 100,
      candidateLimit: 1000,
      candidateCount: 120,
      candidateLimitReached: false,
      matchedCount: 60,
      returnedCount: 60,
      bounded: true,
    });
    expect(recorded.listCalls).toEqual([{ cwd: "/repo", state: "open", limit: 1000 }]);
    expect(JSON.parse(recorded.cacheWrites[0]?.listFilter ?? "{}")).toEqual({
      state: "open",
      limit: 100,
      search: null,
      author: null,
      reviewRequested: null,
      baseBranch: null,
      headBranch: null,
      label: null,
      assignee: null,
      draft: null,
      columns: ["approved"],
      checks: ["failing"],
    });
  });
});

it.effect("pushes a single label filter to GitHub and keeps it in the cache key", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [
      ghPr({ number: 1, title: "Bug fix", labels: ["bug"] }),
      ghPr({ number: 2, title: "Feature work", labels: ["feature"] }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      label: "bug",
    });

    expect(numbers(result)).toEqual([1]);
    expect(recorded.listCalls).toEqual([
      {
        cwd: "/repo",
        state: "open",
        limit: 50,
        label: "bug",
      },
    ]);
    expect(JSON.parse(recorded.cacheWrites[0]?.listFilter ?? "{}")).toEqual({
      state: "open",
      limit: 50,
      search: null,
      author: null,
      reviewRequested: null,
      baseBranch: null,
      headBranch: null,
      label: "bug",
      assignee: null,
      draft: null,
      columns: [],
      checks: [],
    });
  });
});

it.effect("pushes a single assignee filter to GitHub and keeps it in the cache key", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [
      ghPr({ number: 1, title: "Assigned work", assignees: ["alice"] }),
      ghPr({ number: 2, title: "Unassigned work", assignees: [] }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      assignee: "alice",
    });

    expect(numbers(result)).toEqual([1]);
    expect(recorded.listCalls).toEqual([
      {
        cwd: "/repo",
        state: "open",
        limit: 50,
        assignee: "alice",
      },
    ]);
    expect(JSON.parse(recorded.cacheWrites[0]?.listFilter ?? "{}")).toEqual({
      state: "open",
      limit: 50,
      search: null,
      author: null,
      reviewRequested: null,
      baseBranch: null,
      headBranch: null,
      label: null,
      assignee: "alice",
      draft: null,
      columns: [],
      checks: [],
    });
  });
});

it.effect("pushes a single draft status to GitHub without the local candidate window", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [
      ghPr({ number: 1, isDraft: true }),
      ghPr({ number: 2, isDraft: false }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      limit: 200,
      draft: true,
      columns: ["draft"],
    });

    expect(numbers(result)).toEqual([1]);
    expect(result.meta).toEqual({
      requestedLimit: 200,
      resultLimit: 100,
      candidateLimit: 100,
      candidateCount: 2,
      candidateLimitReached: false,
      matchedCount: 1,
      returnedCount: 1,
      bounded: true,
    });
    expect(recorded.listCalls).toEqual([
      {
        cwd: "/repo",
        state: "open",
        limit: 100,
        draft: true,
      },
    ]);
    expect(JSON.parse(recorded.cacheWrites[0]?.listFilter ?? "{}")).toEqual({
      state: "open",
      limit: 100,
      search: null,
      author: null,
      reviewRequested: null,
      baseBranch: null,
      headBranch: null,
      label: null,
      assignee: null,
      draft: true,
      columns: ["draft"],
      checks: [],
    });
  });
});

it.effect("keeps mixed draft status filters on the local candidate window", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [
      ghPr({ number: 1, isDraft: true }),
      ghPr({ number: 2, reviewDecision: "APPROVED" }),
      ghPr({ number: 3, isDraft: false, reviewDecision: null }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      columns: ["draft", "approved"],
    });

    expect(numbers(result)).toEqual([1, 2]);
    expect(recorded.listCalls).toEqual([
      {
        cwd: "/repo",
        state: "open",
        limit: 1000,
      },
    ]);
    expect(result.meta?.candidateLimit).toBe(1000);
  });
});

it.effect("uses the local candidate window when native draft combines with local checks", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [
      ghPr({ number: 1, isDraft: true, checksStatus: "passing" }),
      ghPr({ number: 2, isDraft: true, checksStatus: "failing" }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      draft: true,
      columns: ["draft"],
      checks: ["passing"],
    });

    expect(numbers(result)).toEqual([1]);
    expect(recorded.listCalls).toEqual([
      {
        cwd: "/repo",
        state: "open",
        limit: 1000,
        draft: true,
      },
    ]);
    expect(result.meta?.candidateLimit).toBe(1000);
  });
});

it.effect("marks locally filtered lists incomplete when the candidate window is exhausted", () => {
  const pullRequests = Array.from({ length: 1000 }, (_, index) =>
    ghPr({
      number: index + 1,
      reviewDecision: "APPROVED",
      checksStatus: "failing",
    }),
  );
  const { layer } = makeLayer({ pullRequests });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      columns: ["approved"],
      checks: ["failing"],
    });

    expect(numbers(result)).toHaveLength(50);
    expect(result.meta).toEqual({
      resultLimit: 50,
      candidateLimit: 1000,
      candidateCount: 1000,
      candidateLimitReached: true,
      matchedCount: 1000,
      returnedCount: 50,
      bounded: true,
    });
  });
});

it.effect("bounds GitHub candidate fetches by 10x for large locally filtered lists", () => {
  const repositoryPullRequestCount = 10_000;
  const pullRequests = Array.from({ length: repositoryPullRequestCount }, (_, index) =>
    ghPr({
      number: index + 1,
      reviewDecision: "APPROVED",
      checksStatus: "failing",
    }),
  );
  const { layer, recorded } = makeLayer({ pullRequests });

  return Effect.gen(function* () {
    const startedAt = performance.now();
    const result = yield* runList(layer, {
      cwd: "/repo",
      columns: ["approved"],
      checks: ["failing"],
    });
    const elapsedMs = performance.now() - startedAt;
    const candidateFetchReduction =
      repositoryPullRequestCount / (result.meta?.candidateLimit ?? repositoryPullRequestCount);

    console.info(
      "[benchmark] review source filtered list",
      JSON.stringify({
        repositoryPullRequestCount,
        requestedCandidateLimit: recorded.listCalls[0]?.limit,
        candidateFetchReduction,
        returnedCount: result.pullRequests.length,
        elapsedMs: Math.round(elapsedMs),
      }),
    );

    expect(recorded.listCalls).toEqual([{ cwd: "/repo", state: "open", limit: 1000 }]);
    expect(result.pullRequests).toHaveLength(50);
    expect(result.meta).toEqual({
      resultLimit: 50,
      candidateLimit: 1000,
      candidateCount: 1000,
      candidateLimitReached: true,
      matchedCount: 1000,
      returnedCount: 50,
      bounded: true,
    });
    expect(candidateFetchReduction).toBeGreaterThanOrEqual(10);
  });
});

it.effect("keeps GitHub @me author and reviewer filters after local re-filtering", () => {
  const { layer, recorded } = makeLayer({
    viewerLogin: "tyler",
    pullRequests: [
      ghPr({ number: 1, author: "tyler", reviewRequests: ["tyler"] }),
      ghPr({ number: 2, author: "alice", reviewRequests: ["tyler"] }),
      ghPr({ number: 3, author: "tyler", reviewRequests: ["alice"] }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      author: "@me",
      reviewRequested: "@me",
    });

    expect(numbers(result)).toEqual([1]);
    expect(recorded.listCalls).toEqual([
      {
        cwd: "/repo",
        state: "open",
        limit: 50,
        author: "@me",
        reviewRequested: "@me",
      },
    ]);
  });
});
