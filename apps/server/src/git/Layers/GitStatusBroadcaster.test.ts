import type { GitStatusInput, GitStatusResult, GitStatusStreamEvent } from "@synara/contracts";
import { Deferred, Effect, Fiber, Layer, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitCommandError, type GitManagerServiceError } from "../Errors";
import { GitCore, type GitCoreShape, type GitStatusDetails } from "../Services/GitCore";
import { GitManager, type GitManagerShape } from "../Services/GitManager";
import { GitStatusBroadcaster } from "../Services/GitStatusBroadcaster";
import { GitStatusBroadcasterLive } from "./GitStatusBroadcaster";

const baseStatus: GitStatusResult = {
  branch: "feature/status-broadcast",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  upstreamBranch: "feature/status-broadcast",
  aheadCount: 0,
  behindCount: 0,
  publication: {
    state: "published",
    remoteBranch: "feature/status-broadcast",
    url: "https://github.com/acme/repo/tree/feature/status-broadcast",
  },
  pr: null,
};

const baseDetails: GitStatusDetails = {
  isRepo: true,
  hasOriginRemote: true,
  isDefaultBranch: false,
  branch: baseStatus.branch,
  upstreamRef: "origin/feature/status-broadcast",
  upstreamBranch: baseStatus.upstreamBranch,
  hasWorkingTreeChanges: baseStatus.hasWorkingTreeChanges,
  workingTree: baseStatus.workingTree,
  hasUpstream: baseStatus.hasUpstream,
  aheadCount: baseStatus.aheadCount,
  behindCount: baseStatus.behindCount,
};

interface TestState {
  currentDetails: GitStatusDetails;
  currentStatus: GitStatusResult;
  detailsCalls: number;
  statusCalls: number;
  statusInputs?: GitStatusInput[];
  statusGate?: Deferred.Deferred<void>;
  statusStarted?: Deferred.Deferred<void>;
  statusError?: GitManagerServiceError;
}

function makeTestLayer(state: TestState) {
  const gitCore = {
    statusDetails: () =>
      Effect.sync(() => {
        state.detailsCalls += 1;
        return state.currentDetails;
      }),
  } as unknown as GitCoreShape;
  const gitManager: GitManagerShape = {
    status: (input) =>
      Effect.gen(function* () {
        state.statusCalls += 1;
        state.statusInputs?.push(input);
        if (state.statusStarted) yield* Deferred.succeed(state.statusStarted, undefined);
        if (state.statusGate) yield* Deferred.await(state.statusGate);
        if (state.statusError) return yield* state.statusError;
        return state.currentStatus;
      }),
    readWorkingTreeDiff: () => Effect.die("readWorkingTreeDiff should not be called in this test"),
    summarizeDiff: () => Effect.die("summarizeDiff should not be called in this test"),
    resolvePullRequest: () => Effect.die("resolvePullRequest should not be called in this test"),
    listPullRequests: () => Effect.die("listPullRequests should not be called in this test"),
    pullRequestSnapshot: () => Effect.die("pullRequestSnapshot should not be called in this test"),
    preparePullRequestThread: () =>
      Effect.die("preparePullRequestThread should not be called in this test"),
    handoffThread: () => Effect.die("handoffThread should not be called in this test"),
    runStackedAction: () => Effect.die("runStackedAction should not be called in this test"),
  };

  return GitStatusBroadcasterLive.pipe(
    Layer.provide(
      Layer.mergeAll(Layer.succeed(GitCore, gitCore), Layer.succeed(GitManager, gitManager)),
    ),
  );
}

const runBroadcasterTest = (
  state: TestState,
  effect: Effect.Effect<void, GitManagerServiceError, GitStatusBroadcaster | Scope.Scope>,
) => effect.pipe(Effect.provide(makeTestLayer(state)), Effect.scoped, Effect.runPromise);

afterEach(() => {
  vi.useRealTimers();
});

describe("GitStatusBroadcasterLive", () => {
  it("coalesces overlapping status reads for the same account", async () => {
    const statusGate = await Effect.runPromise(Deferred.make<void>());
    const statusStarted = await Effect.runPromise(Deferred.make<void>());
    const state: TestState = {
      currentDetails: baseDetails,
      currentStatus: baseStatus,
      detailsCalls: 0,
      statusCalls: 0,
      statusGate,
      statusStarted,
    };

    await runBroadcasterTest(
      state,
      Effect.gen(function* () {
        const broadcaster = yield* GitStatusBroadcaster;
        const input = { cwd: "/repo", account: { host: "github.com", login: "octocat" } };
        const first = yield* broadcaster.getStatus(input).pipe(Effect.forkScoped);
        yield* Deferred.await(statusStarted);
        const second = yield* broadcaster.getStatus(input).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        expect(state.statusCalls).toBe(1);
        yield* Deferred.succeed(statusGate, undefined);
        expect(yield* Fiber.join(first)).toEqual(baseStatus);
        expect(yield* Fiber.join(second)).toEqual(baseStatus);
      }),
    );
  });

  it("keeps caches isolated by selected GitHub account", async () => {
    const state: TestState = {
      currentDetails: baseDetails,
      currentStatus: baseStatus,
      detailsCalls: 0,
      statusCalls: 0,
      statusInputs: [],
    };

    await runBroadcasterTest(
      state,
      Effect.gen(function* () {
        const broadcaster = yield* GitStatusBroadcaster;
        yield* broadcaster.getStatus({
          cwd: "/repo",
          account: { host: "github.com", login: "octo-one" },
        });
        yield* broadcaster.getStatus({
          cwd: "/repo",
          account: { host: "github.com", login: "octo-two" },
        });

        expect(state.statusCalls).toBe(2);
        expect(state.statusInputs?.map((input) => input.account?.login)).toEqual([
          "octo-one",
          "octo-two",
        ]);
      }),
    );
  });

  it("backs off repeated status failures", async () => {
    const state: TestState = {
      currentDetails: baseDetails,
      currentStatus: baseStatus,
      detailsCalls: 0,
      statusCalls: 0,
      statusError: new GitCommandError({
        operation: "GitCore.statusDetails.status",
        command: "git status",
        cwd: "/repo",
        detail: "status timed out",
      }),
    };

    await runBroadcasterTest(
      state,
      Effect.gen(function* () {
        const broadcaster = yield* GitStatusBroadcaster;
        yield* Effect.result(broadcaster.getStatus({ cwd: "/repo" }));
        yield* Effect.result(broadcaster.getStatus({ cwd: "/repo" }));

        expect(state.statusCalls).toBe(1);
      }),
    );
  });

  it("keeps partial status usable without repeating the full status lookup", async () => {
    const partialWorkingTree = {
      files: [{ path: "src/first.ts", insertions: 0, deletions: 0 }],
      insertions: 0,
      deletions: 0,
      totalFiles: 4_542,
      isPartial: true,
      truncated: true,
      statisticsState: "partial" as const,
    };
    const state: TestState = {
      currentDetails: {
        ...baseDetails,
        hasWorkingTreeChanges: true,
        workingTree: partialWorkingTree,
      },
      currentStatus: {
        ...baseStatus,
        hasWorkingTreeChanges: true,
        workingTree: partialWorkingTree,
      },
      detailsCalls: 0,
      statusCalls: 0,
    };

    await runBroadcasterTest(
      state,
      Effect.gen(function* () {
        const broadcaster = yield* GitStatusBroadcaster;

        const first = yield* broadcaster.getStatus({ cwd: "/repo" });
        const second = yield* broadcaster.getStatus({ cwd: "/repo" });

        expect(first.workingTree).toEqual(partialWorkingTree);
        expect(second.workingTree).toEqual(partialWorkingTree);
        expect(state.statusCalls).toBe(1);
        expect(state.detailsCalls).toBe(1);
      }),
    );
  });

  it("refreshes local git status on repeated reads without repeating PR lookup", async () => {
    const state = {
      currentDetails: baseDetails,
      currentStatus: baseStatus,
      detailsCalls: 0,
      statusCalls: 0,
    };

    await runBroadcasterTest(
      state,
      Effect.gen(function* () {
        const broadcaster = yield* GitStatusBroadcaster;

        const first = yield* broadcaster.getStatus({ cwd: "/repo" });
        state.currentDetails = {
          ...baseDetails,
          hasWorkingTreeChanges: true,
          workingTree: {
            files: [{ path: "src/app.ts", insertions: 5, deletions: 1 }],
            insertions: 5,
            deletions: 1,
          },
        };
        const second = yield* broadcaster.getStatus({ cwd: "/repo" });

        expect(first).toEqual(baseStatus);
        expect(second).toEqual({
          ...baseStatus,
          hasWorkingTreeChanges: true,
          workingTree: state.currentDetails.workingTree,
        });
        expect(state.statusCalls).toBe(1);
        expect(state.detailsCalls).toBe(1);
      }),
    );
  });

  it("refreshes full status when cached remote metadata expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const state = {
      currentDetails: baseDetails,
      currentStatus: baseStatus,
      detailsCalls: 0,
      statusCalls: 0,
    };

    await runBroadcasterTest(
      state,
      Effect.gen(function* () {
        const broadcaster = yield* GitStatusBroadcaster;

        const first = yield* broadcaster.getStatus({ cwd: "/repo" });
        vi.setSystemTime(31_000);
        state.currentStatus = {
          ...baseStatus,
          pr: {
            number: 42,
            title: "Open PR",
            url: "https://github.com/acme/repo/pull/42",
            state: "open",
            baseBranch: "main",
            headBranch: "feature/status-refresh",
            isDraft: false,
            mergeability: "unknown",
            additions: null,
            deletions: null,
            changedFiles: null,
          },
        };
        const second = yield* broadcaster.getStatus({ cwd: "/repo" });

        expect(first.pr).toBeNull();
        expect(second.pr?.number).toBe(42);
        expect(state.statusCalls).toBe(2);
        expect(state.detailsCalls).toBe(1);
      }),
    );
  });

  it("does not extend the remote metadata TTL when reusing cached remote status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const state = {
      currentDetails: baseDetails,
      currentStatus: baseStatus,
      detailsCalls: 0,
      statusCalls: 0,
    };

    await runBroadcasterTest(
      state,
      Effect.gen(function* () {
        const broadcaster = yield* GitStatusBroadcaster;

        yield* broadcaster.getStatus({ cwd: "/repo" });
        vi.setSystemTime(20_000);
        yield* broadcaster.getStatus({ cwd: "/repo" });

        vi.setSystemTime(31_000);
        state.currentStatus = {
          ...baseStatus,
          pr: {
            number: 43,
            title: "Fresh PR",
            url: "https://github.com/acme/repo/pull/43",
            state: "open",
            baseBranch: "main",
            headBranch: "feature/status-refresh",
            isDraft: false,
            mergeability: "unknown",
            additions: null,
            deletions: null,
            changedFiles: null,
          },
        };
        const third = yield* broadcaster.getStatus({ cwd: "/repo" });

        expect(third.pr?.number).toBe(43);
        expect(state.statusCalls).toBe(2);
        expect(state.detailsCalls).toBe(2);
      }),
    );
  });

  it("refreshes the cached snapshot after explicit invalidation", async () => {
    const state = {
      currentDetails: baseDetails,
      currentStatus: baseStatus,
      detailsCalls: 0,
      statusCalls: 0,
    };

    await runBroadcasterTest(
      state,
      Effect.gen(function* () {
        const broadcaster = yield* GitStatusBroadcaster;
        const initial = yield* broadcaster.getStatus({ cwd: "/repo" });

        state.currentStatus = {
          ...baseStatus,
          branch: "feature/updated-status",
          aheadCount: 2,
        };
        state.currentDetails = {
          ...baseDetails,
          branch: "feature/updated-status",
          aheadCount: 2,
        };
        const refreshed = yield* broadcaster.refreshStatus("/repo");
        const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

        expect(initial).toEqual(baseStatus);
        expect(refreshed).toEqual(state.currentStatus);
        expect(cached).toEqual(state.currentStatus);
        expect(state.statusCalls).toBe(2);
        expect(state.detailsCalls).toBe(1);
      }),
    );
  });

  it("streams a status snapshot first and later refresh updates", async () => {
    const state = {
      currentDetails: baseDetails,
      currentStatus: baseStatus,
      detailsCalls: 0,
      statusCalls: 0,
    };

    await runBroadcasterTest(
      state,
      Effect.gen(function* () {
        const broadcaster = yield* GitStatusBroadcaster;
        const snapshotDeferred = yield* Deferred.make<GitStatusStreamEvent>();
        const localUpdatedDeferred = yield* Deferred.make<GitStatusStreamEvent>();

        yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) => {
          if (event._tag === "snapshot") {
            return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
          }
          if (event._tag === "localUpdated") {
            return Deferred.succeed(localUpdatedDeferred, event).pipe(Effect.ignore);
          }
          return Effect.void;
        }).pipe(Effect.forkScoped);

        const snapshot = yield* Deferred.await(snapshotDeferred);
        state.currentStatus = {
          ...baseStatus,
          branch: "feature/local-refresh",
        };
        yield* broadcaster.refreshStatus("/repo");
        const localUpdated = yield* Deferred.await(localUpdatedDeferred);

        expect(snapshot).toEqual({
          _tag: "snapshot",
          local: {
            branch: baseStatus.branch,
            hasWorkingTreeChanges: baseStatus.hasWorkingTreeChanges,
            workingTree: baseStatus.workingTree,
          },
          remote: {
            hasUpstream: baseStatus.hasUpstream,
            upstreamBranch: baseStatus.upstreamBranch,
            aheadCount: baseStatus.aheadCount,
            behindCount: baseStatus.behindCount,
            publication: baseStatus.publication,
            pr: baseStatus.pr,
          },
        });
        expect(localUpdated).toEqual({
          _tag: "localUpdated",
          local: {
            branch: "feature/local-refresh",
            hasWorkingTreeChanges: false,
            workingTree: baseStatus.workingTree,
          },
        });
      }),
    );
  });

  it("refreshes every account-keyed subscriber after a cwd mutation", async () => {
    const state: TestState = {
      currentDetails: baseDetails,
      currentStatus: baseStatus,
      detailsCalls: 0,
      statusCalls: 0,
      statusInputs: [],
    };

    await runBroadcasterTest(
      state,
      Effect.gen(function* () {
        const broadcaster = yield* GitStatusBroadcaster;
        const firstSnapshot = yield* Deferred.make<GitStatusStreamEvent>();
        const secondSnapshot = yield* Deferred.make<GitStatusStreamEvent>();
        const firstUpdate = yield* Deferred.make<GitStatusStreamEvent>();
        const secondUpdate = yield* Deferred.make<GitStatusStreamEvent>();

        const streamAccount = (
          login: string,
          snapshot: Deferred.Deferred<GitStatusStreamEvent>,
          update: Deferred.Deferred<GitStatusStreamEvent>,
        ) =>
          Stream.runForEach(
            broadcaster.streamStatus({
              cwd: "/repo",
              account: { host: "github.com", login },
            }),
            (event) => {
              if (event._tag === "snapshot") {
                return Deferred.succeed(snapshot, event).pipe(Effect.ignore);
              }
              if (event._tag === "localUpdated") {
                return Deferred.succeed(update, event).pipe(Effect.ignore);
              }
              return Effect.void;
            },
          ).pipe(Effect.forkScoped);

        yield* streamAccount("octo-one", firstSnapshot, firstUpdate);
        yield* streamAccount("octo-two", secondSnapshot, secondUpdate);
        yield* Deferred.await(firstSnapshot);
        yield* Deferred.await(secondSnapshot);

        state.currentStatus = { ...baseStatus, branch: "feature/account-refresh" };
        yield* broadcaster.refreshStatus("/repo");

        expect((yield* Deferred.await(firstUpdate))._tag).toBe("localUpdated");
        expect((yield* Deferred.await(secondUpdate))._tag).toBe("localUpdated");
        expect(state.statusInputs?.map((input) => input.account?.login ?? null)).toEqual([
          "octo-one",
          "octo-two",
          null,
          "octo-one",
          "octo-two",
        ]);
      }),
    );
  });
});
