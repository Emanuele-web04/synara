import { it } from "@effect/vitest";
import type {
  ReviewBoardLanesResult,
  ReviewListPullRequestsResult,
  ReviewPullRequestOverview,
  ReviewPullRequestSummary,
  ReviewUpdatedPayload,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Stream } from "effect";
import { expect } from "vitest";

import { GitHubCliError } from "../../git/Errors.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import {
  GitHubCli,
  type GitHubReviewPullRequestOverview,
  type GitHubCliShape,
  type GitHubReviewPullRequest,
  type GitHubReviewTimelineEvent,
} from "../../git/Services/GitHubCli.ts";
import { GitManager, type GitManagerShape } from "../../git/Services/GitManager.ts";
import { TextGeneration, type TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import {
  type ReviewCacheEnvelope,
  ReviewCacheStore,
  type ReviewCacheStoreShape,
  type ReviewCacheWrite,
} from "../Services/ReviewCacheStore.ts";
import {
  ReviewPullRequestStore,
  type ReviewPullRequestStoreShape,
} from "../Services/ReviewPullRequestStore.ts";
import { ReviewSource, type ReviewSourceShape } from "../Services/ReviewSource.ts";
import { ReviewSync, type ReviewSyncShape } from "../Services/ReviewSync.ts";
import { ReviewUpdateBus } from "../Services/ReviewUpdateBus.ts";
import { deriveReviewLane } from "../reviewLane.ts";
import { ReviewSourceLive } from "./ReviewSource.ts";

function boardSummary(
  overrides: Partial<ReviewPullRequestSummary> & { number: number },
): ReviewPullRequestSummary {
  return {
    number: overrides.number,
    title: overrides.title ?? `PR ${String(overrides.number)}`,
    url: overrides.url ?? `https://github.com/acme/repo/pull/${String(overrides.number)}`,
    baseBranch: overrides.baseBranch ?? "main",
    headBranch: overrides.headBranch ?? `branch-${String(overrides.number)}`,
    ...(overrides.headSelector !== undefined ? { headSelector: overrides.headSelector } : {}),
    author: overrides.author ?? "alice",
    updatedAt: overrides.updatedAt ?? "2026-06-16T00:00:00.000Z",
    state: overrides.state ?? "open",
    reviewDecision: overrides.reviewDecision ?? null,
    isDraft: overrides.isDraft ?? false,
    additions: overrides.additions ?? 1,
    deletions: overrides.deletions ?? 0,
    checksStatus: overrides.checksStatus ?? "none",
    reviewRequests: overrides.reviewRequests ?? [],
    labels: overrides.labels ?? [],
    assignees: overrides.assignees ?? [],
  };
}

function fakePullRequestStore(
  pullRequests: ReadonlyArray<ReviewPullRequestSummary>,
  tokenIdentity = "gh-user-v2:tyler",
): ReviewPullRequestStoreShape {
  const byLane = new Map<string, ReviewPullRequestSummary[]>();
  for (const pullRequest of pullRequests) {
    const lane = deriveReviewLane(pullRequest);
    if (lane === "merged") {
      continue;
    }
    const existing = byLane.get(lane) ?? [];
    existing.push(pullRequest);
    byLane.set(lane, existing);
  }
  for (const lane of byLane.values()) {
    lane.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }
  return {
    upsertPullRequest: () => Effect.void,
    upsertPullRequests: () => Effect.void,
    hasOpenPullRequests: () => Effect.succeed(pullRequests.length > 0),
    getLane: (input) => Effect.succeed((byLane.get(input.lane) ?? []).slice(0, input.limit)),
    queryPullRequests: (input) => {
      const matched = pullRequests.filter((pr) => {
        if (input.state !== "all" && pr.state !== input.state) return false;
        if ((input.lanes?.length ?? 0) > 0 && !input.lanes!.includes(deriveReviewLane(pr)))
          return false;
        if ((input.authors?.length ?? 0) > 0 && !input.authors!.includes(pr.author)) return false;
        if ((input.baseBranches?.length ?? 0) > 0 && !input.baseBranches!.includes(pr.baseBranch))
          return false;
        if (
          (input.headBranches?.length ?? 0) > 0 &&
          !input.headBranches!.includes(pr.headBranch) &&
          !(pr.headSelector !== undefined && input.headBranches!.includes(pr.headSelector))
        )
          return false;
        if (input.draft === true && !pr.isDraft) return false;
        if (
          (input.labels?.length ?? 0) > 0 &&
          !(pr.labels ?? []).some((label) => input.labels!.includes(label))
        )
          return false;
        if (
          (input.assignees?.length ?? 0) > 0 &&
          !(pr.assignees ?? []).some((login) => input.assignees!.includes(login))
        )
          return false;
        if (
          input.reviewRequested !== undefined &&
          !(pr.reviewRequests ?? []).includes(input.reviewRequested)
        )
          return false;
        return true;
      });
      const sorted = [...matched].sort((a, b) =>
        input.sort === "size"
          ? b.additions + b.deletions - (a.additions + a.deletions)
          : Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
      );
      return Effect.succeed(sorted.slice(0, input.limit));
    },
    getOpenContentHashes: () =>
      Effect.succeed(new Map(pullRequests.map((pr) => [pr.number, String(pr.number)] as const))),
    tombstoneExcept: () => Effect.void,
    clearRepository: () => Effect.void,
    getSyncState: () =>
      Effect.succeed(
        Option.some({
          repositoryId: "repo",
          tokenIdentity,
          lastSeenUpdatedAt: null,
          lastSyncedAt: Number.MAX_SAFE_INTEGER,
          fullResyncedAt: null,
          lastGraphqlCost: null,
          pointsRemaining: null,
          rateResetAt: null,
        }),
      ),
    upsertSyncState: () => Effect.void,
  };
}

interface RecordedListCall {
  readonly cwd: string;
  readonly state: "open" | "closed" | "merged" | "all";
  readonly limit?: number;
  readonly search?: string;
  readonly author?: string;
  readonly authors?: ReadonlyArray<string>;
  readonly reviewRequested?: string;
  readonly baseBranch?: string;
  readonly baseBranches?: ReadonlyArray<string>;
  readonly headBranch?: string;
  readonly headBranches?: ReadonlyArray<string>;
  readonly label?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly assignee?: string;
  readonly assignees?: ReadonlyArray<string>;
  readonly draft?: boolean;
  readonly checksStatuses?: ReadonlyArray<"passing" | "failing" | "pending">;
  readonly reviewStatus?: "approved" | "changes-requested";
}

interface RecordedCacheWrite {
  readonly repositoryId: string;
  readonly listFilter: string;
  readonly data: ReviewListPullRequestsResult;
  readonly tokenIdentity: string;
}

interface RecordedSyncCall {
  readonly cwd: string;
  readonly repositoryId: string;
  readonly tokenIdentity: string;
  readonly mode?: "delta" | "full";
}

const fakeReviewSync: ReviewSyncShape = {
  syncRepository: () =>
    Effect.succeed({
      upserted: 0,
      skippedUnchanged: 0,
      pagesFetched: 0,
      reconciled: false,
      stopReason: "end",
      pointsRemaining: null,
    }),
};

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
  readonly boardLanes?: ReadonlyArray<ReviewPullRequestSummary>;
  readonly mirrorTokenIdentity?: string;
}) {
  const recorded = {
    listCalls: [] as RecordedListCall[],
    cacheWrites: [] as RecordedCacheWrite[],
    published: [] as ReviewUpdatedPayload[],
    syncCalls: [] as RecordedSyncCall[],
    authenticatedUserCalls: 0,
    repositoryIdCalls: 0,
  };
  const viewerLogin = options.viewerLogin ?? "tyler";
  const tokenIdentity = `gh-user-v2:${viewerLogin}`;

  const gitHubCli: GitHubCliShape = {
    getAuthenticatedUser: () =>
      Effect.sync(() => {
        recorded.authenticatedUserCalls += 1;
        return {
          login: viewerLogin,
          avatarUrl: "https://avatar.test",
        };
      }),
    listRepositoryPullRequests: (input) => {
      return Effect.sync(() => {
        recorded.listCalls.push(input);
        const limit = input.limit ?? options.pullRequests.length;
        return options.pullRequests.slice(0, limit);
      });
    },
    execute: () => unexpected("GitHubCli.execute"),
    listOpenPullRequests: () => unexpected("GitHubCli.listOpenPullRequests"),
    getPullRequest: () => unexpected("GitHubCli.getPullRequest"),
    getReviewPullRequestOverview: () =>
      Effect.fail(new GitHubCliError({ operation: "test", detail: "unexpected overview" })),
    getReviewPullRequestHeader: () =>
      Effect.fail(new GitHubCliError({ operation: "test", detail: "unexpected header" })),
    getReviewConversation: () =>
      Effect.fail(new GitHubCliError({ operation: "test", detail: "unexpected conversation" })),
    getReviewTimeline: () =>
      Effect.fail(new GitHubCliError({ operation: "test", detail: "unexpected timeline" })),
    getPullRequestDiff: () => unexpected("GitHubCli.getPullRequestDiff"),
    getPullRequestHeadSha: () => unexpected("GitHubCli.getPullRequestHeadSha"),
    submitPullRequestReview: () => unexpected("GitHubCli.submitPullRequestReview"),
    createPullRequestReviewWithComments: () =>
      unexpected("GitHubCli.createPullRequestReviewWithComments"),
    getPullRequestThreads: () => unexpected("GitHubCli.getPullRequestThreads"),
    setPullRequestThreadResolution: () => unexpected("GitHubCli.setPullRequestThreadResolution"),
    addPullRequestThreadReply: () => unexpected("GitHubCli.addPullRequestThreadReply"),
    updatePullRequestThreadComment: () => unexpected("GitHubCli.updatePullRequestThreadComment"),
    deletePullRequestThreadComment: () => unexpected("GitHubCli.deletePullRequestThreadComment"),
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
      Effect.sync(() => {
        recorded.repositoryIdCalls += 1;
        return {
          code: 0,
          stdout: "/repo\n",
          stderr: "",
        };
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
        (entry) =>
          entry.repositoryId === input.repositoryId && entry.listFilter === input.listFilter,
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
    upsertPullRequestList: (
      input: ReviewCacheWrite<ReviewListPullRequestsResult> & {
        readonly listFilter: string;
      },
    ) => {
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
    generateAutomationIntent: () => unexpectedEffect("TextGeneration.generateAutomationIntent"),
    evaluateAutomationCompletion: () =>
      unexpectedEffect("TextGeneration.evaluateAutomationCompletion"),
  };

  const reviewSync: ReviewSyncShape = {
    syncRepository: (input) =>
      Effect.sync(() => {
        recorded.syncCalls.push({
          cwd: input.cwd,
          repositoryId: input.repositoryId,
          tokenIdentity: input.tokenIdentity,
          ...(input.mode !== undefined ? { mode: input.mode } : {}),
        });
        return {
          upserted: 0,
          skippedUnchanged: 0,
          pagesFetched: 0,
          reconciled: false,
          stopReason: "end" as const,
          pointsRemaining: null,
        };
      }),
  };

  const depsLayer = Layer.mergeAll(
    Layer.succeed(GitHubCli, gitHubCli),
    Layer.succeed(GitCore, gitCore),
    Layer.succeed(GitManager, gitManager),
    Layer.succeed(TextGeneration, textGeneration),
    Layer.succeed(ReviewCacheStore, cacheStore),
    Layer.succeed(
      ReviewPullRequestStore,
      fakePullRequestStore(options.boardLanes ?? [], options.mirrorTokenIdentity ?? tokenIdentity),
    ),
    Layer.succeed(ReviewSync, reviewSync),
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
  input: Parameters<ReviewSourceShape["listPullRequests"]>[0],
) =>
  Effect.gen(function* () {
    const reviewSource = yield* ReviewSource;
    return yield* reviewSource.listPullRequests(input);
  }).pipe(Effect.provide(layer));

const runBoardLanes = (
  layer: Layer.Layer<ReviewSource>,
  input: Parameters<ReviewSourceShape["loadBoardLanes"]>[0],
) =>
  Effect.gen(function* () {
    const reviewSource = yield* ReviewSource;
    return yield* reviewSource.loadBoardLanes(input);
  }).pipe(Effect.provide(layer));

function numbers(result: ReviewListPullRequestsResult): number[] {
  return result.pullRequests.map((pullRequest: ReviewPullRequestSummary) => pullRequest.number);
}

function laneNumbers(result: ReviewBoardLanesResult, lane: keyof ReviewBoardLanesResult): number[] {
  return numbers(result[lane]);
}

function makeSurfaceLayer(
  options: {
    readonly overview?: GitHubReviewPullRequestOverview;
    readonly cachedOverview?: ReviewPullRequestOverview;
  } = {},
) {
  const recorded = {
    activeGitHubCalls: 0,
    maxActiveGitHubCalls: 0,
    started: [] as string[],
    finished: [] as string[],
  };

  const trackGitHubCall = <T>(label: string, value: T) =>
    Effect.promise<T>(() => {
      recorded.started.push(label);
      recorded.activeGitHubCalls += 1;
      recorded.maxActiveGitHubCalls = Math.max(
        recorded.maxActiveGitHubCalls,
        recorded.activeGitHubCalls,
      );
      return new Promise((resolve) => {
        setTimeout(() => {
          recorded.activeGitHubCalls -= 1;
          recorded.finished.push(label);
          resolve(value);
        }, 20);
      });
    });

  const overview =
    options.overview ??
    ({
      detail: {
        number: 42,
        title: "Parallel review surface",
        url: "https://github.com/acme/demo/pull/42",
        state: "open",
        isDraft: false,
        author: "alice",
        authorAvatarUrl: "https://avatars.example/alice.png",
        baseBranch: "main",
        headBranch: "feature/review-surface",
        body: "Review body",
        createdAt: "2026-06-16T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
        additions: 10,
        deletions: 2,
        changedFiles: 3,
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
    } satisfies GitHubReviewPullRequestOverview);
  const conversation = [
    {
      kind: "comment",
      id: "comment-1",
      author: "alice",
      body: "Looks good.",
      createdAt: "2026-06-16T00:00:00.000Z",
    },
  ] satisfies ReadonlyArray<GitHubReviewTimelineEvent>;

  const gitHubCli: GitHubCliShape = {
    getAuthenticatedUser: () =>
      Effect.succeed({
        login: "tyler",
        avatarUrl: "https://avatar.test",
      }),
    getReviewPullRequestOverview: () => trackGitHubCall("overview", overview),
    getReviewConversation: () => trackGitHubCall("conversation", conversation),
    getReviewTimeline: () => Effect.succeed([]),
    execute: () => unexpected("GitHubCli.execute"),
    listRepositoryPullRequests: () => unexpected("GitHubCli.listRepositoryPullRequests"),
    listOpenPullRequests: () => unexpected("GitHubCli.listOpenPullRequests"),
    getPullRequest: () => unexpected("GitHubCli.getPullRequest"),
    getReviewPullRequestHeader: () =>
      Effect.fail(new GitHubCliError({ operation: "test", detail: "unexpected header" })),
    getPullRequestDiff: () => unexpected("GitHubCli.getPullRequestDiff"),
    getPullRequestHeadSha: () => unexpected("GitHubCli.getPullRequestHeadSha"),
    submitPullRequestReview: () => unexpected("GitHubCli.submitPullRequestReview"),
    createPullRequestReviewWithComments: () =>
      unexpected("GitHubCli.createPullRequestReviewWithComments"),
    getPullRequestThreads: () => unexpected("GitHubCli.getPullRequestThreads"),
    setPullRequestThreadResolution: () => unexpected("GitHubCli.setPullRequestThreadResolution"),
    addPullRequestThreadReply: () => unexpected("GitHubCli.addPullRequestThreadReply"),
    updatePullRequestThreadComment: () => unexpected("GitHubCli.updatePullRequestThreadComment"),
    deletePullRequestThreadComment: () => unexpected("GitHubCli.deletePullRequestThreadComment"),
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
    getPullRequestList: () => unexpected("ReviewCacheStore.getPullRequestList"),
    upsertPullRequestList: () => unexpected("ReviewCacheStore.upsertPullRequestList"),
    getPullRequestOverview: () =>
      options.cachedOverview
        ? Effect.succeed(
            Option.some({
              data: options.cachedOverview,
              fetchedAt: Date.now(),
              lastValidatedAt: Date.now(),
              ttlMs: 30_000,
              etag: null,
              lastModified: null,
              tokenIdentity: "gh-user-v2:tyler",
              headSha: null,
            } satisfies ReviewCacheEnvelope<ReviewPullRequestOverview>),
          )
        : Effect.succeed(Option.none()),
    upsertPullRequestOverview: () => Effect.void,
    getPullRequestConversation: () => Effect.succeed(Option.none()),
    upsertPullRequestConversation: () => Effect.void,
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
    generateAutomationIntent: () => unexpectedEffect("TextGeneration.generateAutomationIntent"),
    evaluateAutomationCompletion: () =>
      unexpectedEffect("TextGeneration.evaluateAutomationCompletion"),
  };

  const depsLayer = Layer.mergeAll(
    Layer.succeed(GitHubCli, gitHubCli),
    Layer.succeed(GitCore, gitCore),
    Layer.succeed(GitManager, gitManager),
    Layer.succeed(TextGeneration, textGeneration),
    Layer.succeed(ReviewCacheStore, cacheStore),
    Layer.succeed(ReviewPullRequestStore, fakePullRequestStore([])),
    Layer.succeed(ReviewSync, fakeReviewSync),
    Layer.succeed(ReviewUpdateBus, {
      publish: () => Effect.void,
      stream: Stream.empty,
    }),
  );

  return {
    layer: ReviewSourceLive.pipe(Layer.provide(depsLayer)),
    recorded,
  };
}

it.effect("memoizes repository and auth preflight across repeated list requests", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [],
    boardLanes: [
      boardSummary({ number: 1, updatedAt: "2026-06-16T00:01:00.000Z" }),
      boardSummary({ number: 2, updatedAt: "2026-06-16T00:00:00.000Z" }),
    ],
  });

  return Effect.gen(function* () {
    const reviewSource = yield* ReviewSource;
    const first = yield* reviewSource.listPullRequests({ cwd: "/repo" });
    const second = yield* reviewSource.listPullRequests({ cwd: "/repo" });

    expect(numbers(first)).toEqual([1, 2]);
    expect(second).toEqual(first);
    expect(recorded.listCalls).toEqual([]);
    expect(recorded.repositoryIdCalls).toBe(1);
    expect(recorded.authenticatedUserCalls).toBe(1);
  }).pipe(Effect.provide(layer));
});

it.effect("loads aggregate overview and conversation concurrently", () => {
  const { layer, recorded } = makeSurfaceLayer();

  return Effect.gen(function* () {
    const reviewSource = yield* ReviewSource;
    const result = yield* reviewSource.loadPullRequestSurface({
      cwd: "/repo",
      reference: "42",
      source: { _tag: "pullRequest", reference: "42" },
      includeConversation: true,
    });

    expect(result.overview.detail.number).toBe(42);
    expect(result.conversation?.events).toHaveLength(1);
    expect(result.changeset).toBeUndefined();
    expect(recorded.started).toEqual(["overview", "conversation"]);
    expect(recorded.finished).toEqual(["overview", "conversation"]);
    expect(recorded.maxActiveGitHubCalls).toBe(2);
  }).pipe(Effect.provide(layer));
});

it.effect("bypasses overview cache entries without reviewer avatars", () => {
  const cachedOverview = {
    detail: {
      number: 42,
      title: "Cached review sidebar",
      url: "https://github.com/acme/demo/pull/42",
      state: "open",
      isDraft: false,
      author: "alice",
      authorAvatarUrl: "https://avatars.example/alice.png",
      baseBranch: "main",
      headBranch: "feature/review-surface",
      body: "Review body",
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:00.000Z",
      additions: 10,
      deletions: 2,
      changedFiles: 3,
      commitsCount: 1,
      reviewDecision: null,
      mergeable: "MERGEABLE",
      checksStatus: "passing",
      milestone: null,
      labels: [],
      assignees: [],
      reviewers: [{ login: "global-approvers", state: "REVIEW_REQUIRED" }],
    },
    commits: [],
    checks: [],
  } satisfies ReviewPullRequestOverview;
  const refreshedOverview = {
    ...cachedOverview,
    detail: {
      ...cachedOverview.detail,
      reviewers: [
        {
          login: "global-approvers",
          avatarUrl: "https://avatars.example/global-approvers.png",
          state: "REVIEW_REQUIRED",
        },
      ],
    },
  } satisfies ReviewPullRequestOverview & GitHubReviewPullRequestOverview;
  const { layer, recorded } = makeSurfaceLayer({
    cachedOverview,
    overview: refreshedOverview,
  });

  return Effect.gen(function* () {
    const reviewSource = yield* ReviewSource;
    const result = yield* reviewSource.loadPullRequest({ cwd: "/repo", reference: "42" });

    expect(result.detail.reviewers[0]?.avatarUrl).toBe(
      "https://avatars.example/global-approvers.png",
    );
    expect(recorded.started).toEqual(["overview"]);
  }).pipe(Effect.provide(layer));
});

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
      baseBranches: [],
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
      authors: [],
      reviewRequested: null,
      baseBranch: "main",
      baseBranches: [],
      headBranch: "branch-1",
      headBranches: [],
      label: null,
      labels: [],
      assignee: null,
      assignees: [],
      draft: null,
      columns: [],
      checks: [],
    });
  });
});

it.effect("keeps owner-qualified head selectors distinct for fork pull requests", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [],
    boardLanes: [
      boardSummary({ number: 1, title: "Fork one", headBranch: "feature/shared" }),
      boardSummary({
        number: 2,
        title: "Fork two",
        headBranch: "feature/shared",
        headSelector: "octocat:feature/shared",
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
    expect(recorded.listCalls).toEqual([]);
  });
});

it.effect("trusts pull requests returned by GitHub search", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [
      ghPr({ number: 1, title: "Returned by GitHub title search" }),
      ghPr({ number: 2, title: "No local substring match" }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      search: "body-only-match",
    });

    expect(numbers(result)).toEqual([1, 2]);
    expect(recorded.listCalls).toEqual([
      { cwd: "/repo", state: "open", limit: 50, search: "body-only-match" },
    ]);
  });
});

it.effect("loads default board lanes from the local mirror, newest first per lane", () => {
  const boardLanes = [
    boardSummary({ number: 1, reviewDecision: null, updatedAt: "2026-06-16T00:04:00.000Z" }),
    boardSummary({
      number: 2,
      reviewDecision: "CHANGES_REQUESTED",
      updatedAt: "2026-06-16T00:03:00.000Z",
    }),
    boardSummary({ number: 3, reviewDecision: "APPROVED", updatedAt: "2026-06-16T00:02:00.000Z" }),
    boardSummary({ number: 4, isDraft: true, updatedAt: "2026-06-16T00:01:00.000Z" }),
    boardSummary({ number: 5, reviewDecision: null, updatedAt: "2026-06-16T00:00:00.000Z" }),
  ];
  const { layer } = makeLayer({ pullRequests: [], boardLanes });

  return Effect.gen(function* () {
    const result = yield* runBoardLanes(layer, { cwd: "/repo", limit: 1 });

    expect(laneNumbers(result, "needs-review")).toEqual([1]);
    expect(laneNumbers(result, "changes-requested")).toEqual([2]);
    expect(laneNumbers(result, "approved")).toEqual([3]);
    expect(laneNumbers(result, "draft")).toEqual([4]);
  });
});

it.effect(
  "pushes native review status and check filters without the local candidate window",
  () => {
    const pullRequests = Array.from({ length: 4 }, (_, index) =>
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

      expect(numbers(result)).toEqual([1, 3]);
      expect(result.meta).toEqual({
        requestedLimit: 200,
        resultLimit: 200,
        candidateLimit: 200,
        candidateCount: 4,
        candidateLimitReached: false,
        matchedCount: 2,
        returnedCount: 2,
        bounded: true,
      });
      expect(recorded.listCalls).toEqual([
        {
          cwd: "/repo",
          state: "open",
          limit: 200,
          reviewStatus: "approved",
          checksStatuses: ["failing"],
        },
      ]);
      expect(JSON.parse(recorded.cacheWrites[0]?.listFilter ?? "{}")).toEqual({
        state: "open",
        limit: 200,
        search: null,
        author: null,
        authors: [],
        reviewRequested: null,
        baseBranch: null,
        baseBranches: [],
        headBranch: null,
        headBranches: [],
        label: null,
        labels: [],
        assignee: null,
        assignees: [],
        draft: null,
        columns: ["approved"],
        checks: ["failing"],
      });
    });
  },
);

it.effect("keeps a larger bounded candidate window when status still needs local filtering", () => {
  const pullRequests = Array.from({ length: 120 }, (_, index) =>
    ghPr({
      number: index + 1,
      reviewDecision: index % 2 === 0 ? null : "APPROVED",
      checksStatus: "failing",
    }),
  );
  const { layer, recorded } = makeLayer({ pullRequests });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      limit: 200,
      columns: ["needs-review"],
      checks: ["failing"],
    });

    expect(numbers(result)).toHaveLength(60);
    expect(result.meta).toEqual({
      requestedLimit: 200,
      resultLimit: 200,
      candidateLimit: 2000,
      candidateCount: 120,
      candidateLimitReached: false,
      matchedCount: 60,
      returnedCount: 60,
      bounded: true,
    });
    expect(recorded.listCalls).toEqual([
      { cwd: "/repo", state: "open", limit: 2000, checksStatuses: ["failing"] },
    ]);
    expect(JSON.parse(recorded.cacheWrites[0]?.listFilter ?? "{}")).toEqual({
      state: "open",
      search: null,
      author: null,
      authors: [],
      reviewRequested: null,
      baseBranch: null,
      baseBranches: [],
      headBranch: null,
      headBranches: [],
      label: null,
      labels: [],
      assignee: null,
      assignees: [],
      draft: null,
      columns: ["needs-review"],
      checks: ["failing"],
    });
  });
});

it.effect("serves label-filtered lists from the mirror up to the result limit", () => {
  // Mixed labelled/unlabelled rows; the mirror filters by label and caps at the limit.
  const boardLanes = Array.from({ length: 700 }, (_, index) =>
    boardSummary({
      number: index + 1,
      labels: index >= 100 ? ["needs,qa"] : ["routine"],
      updatedAt: `2026-06-16T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
    }),
  );
  const { layer, recorded } = makeLayer({ pullRequests: [], boardLanes });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      limit: 500,
      labels: ["needs,qa"],
    });

    expect(numbers(result)).toHaveLength(500);
    expect(numbers(result).every((number) => number >= 101)).toBe(true);
    expect(result.meta).toEqual({
      requestedLimit: 500,
      resultLimit: 500,
      candidateLimit: 501,
      candidateCount: 501,
      candidateLimitReached: true,
      matchedCount: 501,
      returnedCount: 500,
      bounded: true,
    });
    expect(recorded.listCalls).toEqual([]);
  });
});

it.effect("sorts expanded server candidates before slicing bounded list results", () => {
  const pullRequests = Array.from({ length: 100 }, (_, index) =>
    ghPr({
      number: index + 1,
      title: index === 89 ? "AAA outside first page" : `ZZZ review ${String(index + 1)}`,
    }),
  );
  const { layer, recorded } = makeLayer({ pullRequests });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      sort: "title",
    });

    expect(result.pullRequests).toHaveLength(50);
    expect(numbers(result).at(0)).toBe(90);
    expect(result.meta).toEqual({
      resultLimit: 50,
      candidateLimit: 1000,
      candidateCount: 100,
      candidateLimitReached: false,
      matchedCount: 100,
      returnedCount: 50,
      bounded: true,
    });
    expect(recorded.listCalls).toEqual([{ cwd: "/repo", state: "open", limit: 1000 }]);
    expect(JSON.parse(recorded.cacheWrites[0]?.listFilter ?? "{}")).toMatchObject({
      state: "open",
      sort: "title",
    });
    expect(recorded.cacheWrites[0]?.data.pullRequests).toHaveLength(100);
  });
});

it.effect("reuses expanded list candidates when load more only increases the result limit", () => {
  const pullRequests = Array.from({ length: 100 }, (_, index) =>
    ghPr({
      number: index + 1,
      title: index === 89 ? "AAA outside first page" : `ZZZ review ${String(index + 1)}`,
    }),
  );
  const { layer, recorded } = makeLayer({ pullRequests });

  return Effect.gen(function* () {
    const reviewSource = yield* ReviewSource;
    const firstPage = yield* reviewSource.listPullRequests({
      cwd: "/repo",
      sort: "title",
    });
    const secondPage = yield* reviewSource.listPullRequests({
      cwd: "/repo",
      limit: 100,
      sort: "title",
    });

    expect(firstPage.pullRequests).toHaveLength(50);
    expect(secondPage.pullRequests).toHaveLength(100);
    expect(numbers(firstPage).at(0)).toBe(90);
    expect(numbers(secondPage).at(0)).toBe(90);
    expect(secondPage.meta).toEqual({
      requestedLimit: 100,
      resultLimit: 100,
      candidateLimit: 1000,
      candidateCount: 100,
      candidateLimitReached: false,
      matchedCount: 100,
      returnedCount: 100,
      bounded: true,
    });
    expect(recorded.listCalls).toEqual([{ cwd: "/repo", state: "open", limit: 1000 }]);
  }).pipe(Effect.provide(layer));
});

it.effect("bounds sorted candidate fetches to the local filter window", () => {
  const repositoryPullRequestCount = 10_000;
  const pullRequests = Array.from({ length: repositoryPullRequestCount }, (_, index) =>
    ghPr({
      number: index + 1,
      title: `Review ${String(index + 1).padStart(5, "0")}`,
    }),
  );
  const { layer, recorded } = makeLayer({ pullRequests });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      sort: "title",
    });
    const candidateFetchReduction =
      repositoryPullRequestCount / (result.meta?.candidateLimit ?? repositoryPullRequestCount);

    expect(result.pullRequests).toHaveLength(50);
    expect(candidateFetchReduction).toBeGreaterThanOrEqual(10);
    expect(result.meta).toEqual({
      resultLimit: 50,
      candidateLimit: 1000,
      candidateCount: 1000,
      candidateLimitReached: true,
      matchedCount: 1000,
      returnedCount: 50,
      bounded: true,
    });
    expect(recorded.listCalls).toEqual([{ cwd: "/repo", state: "open", limit: 1000 }]);
  });
});

it.effect("serves a single changes-requested column from the mirror", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [],
    boardLanes: [
      boardSummary({ number: 1, reviewDecision: "CHANGES_REQUESTED" }),
      boardSummary({ number: 2, reviewDecision: "APPROVED" }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      columns: ["changes-requested"],
    });

    expect(numbers(result)).toEqual([1]);
    expect(recorded.listCalls).toEqual([]);
    expect(result.meta).toBeUndefined();
  });
});

it.effect("refreshes the mirror before serving rows from a previous GitHub identity", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [],
    mirrorTokenIdentity: "gh-user-v2:previous",
    boardLanes: [boardSummary({ number: 1 })],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, { cwd: "/repo" });

    expect(numbers(result)).toEqual([1]);
    expect(recorded.syncCalls).toHaveLength(1);
    expect(recorded.syncCalls[0]).toMatchObject({
      cwd: "/repo",
      tokenIdentity: "gh-user-v2:tyler",
      mode: "full",
    });
    expect(recorded.syncCalls[0]?.repositoryId).toMatch(/^[a-f0-9]+$/);
    expect(recorded.listCalls).toEqual([]);
  });
});

it.effect("pushes a single check filter to GitHub without the local candidate window", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [
      ghPr({ number: 1, checksStatus: "passing" }),
      ghPr({ number: 2, checksStatus: "failing" }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      limit: 200,
      checks: ["passing"],
    });

    expect(numbers(result)).toEqual([1]);
    expect(result.meta).toEqual({
      requestedLimit: 200,
      resultLimit: 200,
      candidateLimit: 200,
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
        limit: 200,
        checksStatuses: ["passing"],
      },
    ]);
    expect(JSON.parse(recorded.cacheWrites[0]?.listFilter ?? "{}")).toEqual({
      state: "open",
      limit: 200,
      search: null,
      author: null,
      authors: [],
      reviewRequested: null,
      baseBranch: null,
      baseBranches: [],
      headBranch: null,
      headBranches: [],
      label: null,
      labels: [],
      assignee: null,
      assignees: [],
      draft: null,
      columns: [],
      checks: ["passing"],
    });
  });
});

it.effect("serves a single label filter from the mirror", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [],
    boardLanes: [
      boardSummary({ number: 1, title: "Bug fix", labels: ["bug"] }),
      boardSummary({ number: 2, title: "Feature work", labels: ["feature"] }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      label: "bug",
    });

    expect(numbers(result)).toEqual([1]);
    expect(recorded.listCalls).toEqual([]);
    expect(recorded.cacheWrites).toEqual([]);
  });
});

it.effect("serves multi-label OR filters from the mirror", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [],
    boardLanes: [
      boardSummary({ number: 1, title: "Bug fix", labels: ["bug"] }),
      boardSummary({ number: 2, title: "Feature work", labels: ["feature"] }),
      boardSummary({ number: 3, title: "Docs work", labels: ["docs"] }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      labels: ["feature", "bug"],
    });

    expect(numbers(result).sort()).toEqual([1, 2]);
    expect(recorded.listCalls).toEqual([]);
    expect(recorded.cacheWrites).toEqual([]);
  });
});

it.effect("serves comma-bearing multi-label OR filters from the mirror", () => {
  // Commas only mattered for gh-search escaping; the mirror matches labels exactly.
  const { layer, recorded } = makeLayer({
    pullRequests: [],
    boardLanes: [
      boardSummary({ number: 1, title: "Comma label", labels: ["needs,qa"] }),
      boardSummary({ number: 2, title: "Bug fix", labels: ["bug"] }),
      boardSummary({ number: 3, title: "Docs work", labels: ["docs"] }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      labels: ["needs,qa", "bug"],
    });

    expect(numbers(result).sort()).toEqual([1, 2]);
    expect(recorded.listCalls).toEqual([]);
    expect(result.meta).toBeUndefined();
  });
});

it.effect("serves a single assignee filter from the mirror", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [],
    boardLanes: [
      boardSummary({ number: 1, title: "Assigned work", assignees: ["alice"] }),
      boardSummary({ number: 2, title: "Unassigned work", assignees: [] }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      assignee: "alice",
    });

    expect(numbers(result)).toEqual([1]);
    expect(recorded.listCalls).toEqual([]);
    expect(recorded.cacheWrites).toEqual([]);
  });
});

it.effect("serves plural OR filters from the mirror, resolving @me and merging singulars", () => {
  const { layer, recorded } = makeLayer({
    viewerLogin: "tyler",
    pullRequests: [],
    boardLanes: [
      boardSummary({
        number: 1,
        title: "Alice assigned work",
        author: "alice",
        baseBranch: "main",
        headBranch: "feature/shared",
        assignees: ["bob"],
      }),
      boardSummary({
        number: 2,
        title: "Viewer assigned fork work",
        author: "tyler",
        baseBranch: "release",
        headBranch: "feature/shared",
        headSelector: "octocat:feature/shared",
        assignees: ["tyler"],
        updatedAt: "2026-06-16T00:01:00.000Z",
      }),
      boardSummary({
        number: 3,
        title: "Wrong author",
        author: "carol",
        baseBranch: "main",
        headBranch: "feature/shared",
        assignees: ["bob"],
      }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      author: "@me",
      authors: ["alice"],
      baseBranch: "main",
      baseBranches: ["release"],
      headBranch: "feature/shared",
      headBranches: ["octocat:feature/shared"],
      assignee: "@me",
      assignees: ["bob"],
    });

    // @me -> "tyler"; PR1 matches author alice + assignee bob, PR2 matches author tyler +
    // assignee tyler; PR3's author carol is filtered out.
    expect(numbers(result).sort()).toEqual([1, 2]);
    expect(recorded.listCalls).toEqual([]);
    expect(recorded.cacheWrites).toEqual([]);
  });
});

it.effect("serves author OR filters with unmatched names from the mirror", () => {
  // "bad user" simply matches no row; the mirror does exact-membership author filtering.
  const { layer, recorded } = makeLayer({
    pullRequests: [],
    boardLanes: [
      boardSummary({ number: 1, title: "Alice work", author: "alice" }),
      boardSummary({ number: 2, title: "Bob work", author: "bob" }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      authors: ["alice", "bad user"],
    });

    expect(numbers(result)).toEqual([1]);
    expect(recorded.listCalls).toEqual([]);
    expect(result.meta).toBeUndefined();
  });
});

it.effect("serves a single draft status from the mirror", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [],
    boardLanes: [
      boardSummary({ number: 1, isDraft: true }),
      boardSummary({ number: 2, isDraft: false }),
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
    expect(result.meta).toBeUndefined();
    expect(recorded.listCalls).toEqual([]);
    expect(recorded.cacheWrites).toEqual([]);
  });
});

it.effect("serves mixed draft + approved column filters from the mirror", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [],
    boardLanes: [
      boardSummary({ number: 1, isDraft: true }),
      boardSummary({ number: 2, reviewDecision: "APPROVED" }),
      boardSummary({ number: 3, isDraft: false, reviewDecision: null }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      columns: ["draft", "approved"],
    });

    expect(numbers(result).sort()).toEqual([1, 2]);
    expect(recorded.listCalls).toEqual([]);
    expect(result.meta).toBeUndefined();
  });
});

it.effect("pushes native draft and native checks without the local candidate window", () => {
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
        limit: 50,
        draft: true,
        checksStatuses: ["passing"],
      },
    ]);
    expect(result.meta?.candidateLimit).toBe(50);
  });
});

it.effect("pushes precise multi-check OR filters to GitHub", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [
      ghPr({ number: 1, checksStatus: "passing" }),
      ghPr({ number: 2, checksStatus: "failing" }),
      ghPr({ number: 3, checksStatus: "pending" }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      checks: ["passing", "failing"],
    });

    expect(numbers(result)).toEqual([1, 2]);
    expect(recorded.listCalls).toEqual([
      {
        cwd: "/repo",
        state: "open",
        limit: 50,
        checksStatuses: ["failing", "passing"],
      },
    ]);
    expect(result.meta?.candidateLimit).toBe(50);
  });
});

it.effect("keeps pending and none check filters on the local candidate window", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [
      ghPr({ number: 1, checksStatus: "pending" }),
      ghPr({ number: 2, checksStatus: "none" }),
      ghPr({ number: 3, checksStatus: "failing" }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      checks: ["pending", "none"],
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

it.effect("pushes pending check filters through GitHub search with precise checks", () => {
  const { layer, recorded } = makeLayer({
    pullRequests: [
      ghPr({ number: 1, checksStatus: "passing" }),
      ghPr({ number: 2, checksStatus: "pending" }),
      ghPr({ number: 3, checksStatus: "failing" }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      checks: ["passing", "pending"],
    });

    expect(numbers(result)).toEqual([1, 2]);
    expect(recorded.listCalls).toEqual([
      {
        cwd: "/repo",
        state: "open",
        limit: 50,
        checksStatuses: ["passing", "pending"],
      },
    ]);
    expect(result.meta?.candidateLimit).toBe(50);
  });
});

it.effect("marks locally filtered lists incomplete when the candidate window is exhausted", () => {
  const pullRequests = Array.from({ length: 1000 }, (_, index) =>
    ghPr({
      number: index + 1,
      reviewDecision: null,
      checksStatus: "failing",
    }),
  );
  const { layer } = makeLayer({ pullRequests });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      columns: ["needs-review"],
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
      author: index % 2 === 0 ? "alice" : "bob",
      baseRefName: "main",
      headRefName: index % 2 === 0 ? "feature/perf" : "feature/other",
      labels: index % 2 === 0 ? ["perf,label"] : ["other"],
      assignees: index % 2 === 0 ? ["tyler"] : ["someone-else"],
      reviewDecision: null,
      checksStatus: "failing",
    }),
  );
  const { layer, recorded } = makeLayer({ pullRequests });

  return Effect.gen(function* () {
    const startedAt = performance.now();
    const result = yield* runList(layer, {
      cwd: "/repo",
      author: "alice",
      baseBranch: "main",
      headBranch: "feature/perf",
      label: "perf,label",
      assignee: "tyler",
      columns: ["needs-review"],
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

    expect(recorded.listCalls).toEqual([
      {
        cwd: "/repo",
        state: "open",
        limit: 1000,
        author: "alice",
        baseBranch: "main",
        headBranch: "feature/perf",
        assignee: "tyler",
        checksStatuses: ["failing"],
      },
    ]);
    expect(result.pullRequests).toHaveLength(50);
    expect(result.meta).toEqual({
      resultLimit: 50,
      candidateLimit: 1000,
      candidateCount: 1000,
      candidateLimitReached: true,
      matchedCount: 500,
      returnedCount: 50,
      bounded: true,
    });
    expect(candidateFetchReduction).toBeGreaterThanOrEqual(10);
  });
});

it.effect("serves @me author and requested-reviewer filters from the mirror", () => {
  const { layer, recorded } = makeLayer({
    viewerLogin: "tyler",
    pullRequests: [],
    boardLanes: [
      boardSummary({ number: 1, author: "tyler", reviewRequests: ["tyler"] }),
      boardSummary({ number: 2, author: "alice", reviewRequests: ["tyler"] }),
      boardSummary({ number: 3, author: "tyler", reviewRequests: ["alice"] }),
    ],
  });

  return Effect.gen(function* () {
    const result = yield* runList(layer, {
      cwd: "/repo",
      author: "@me",
      authors: [],
      reviewRequested: "@me",
    });

    // Both @me filters resolve to "tyler": PR1 is authored by tyler AND requests tyler;
    // PR2 has the wrong author, PR3 requests the wrong reviewer.
    expect(numbers(result)).toEqual([1]);
    expect(recorded.listCalls).toEqual([]);
  });
});
