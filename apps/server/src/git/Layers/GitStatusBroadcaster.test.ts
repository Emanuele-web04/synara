import type { GitStatusResult, GitStatusStreamEvent } from "@t3tools/contracts";
import { Deferred, Effect, Layer, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { GitManagerServiceError } from "../Errors";
import { GitManager, type GitManagerShape } from "../Services/GitManager";
import { GitStatusBroadcaster } from "../Services/GitStatusBroadcaster";
import { GitStatusBroadcasterLive } from "./GitStatusBroadcaster";

const baseStatus: GitStatusResult = {
  branch: "feature/status-broadcast",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

function makeTestLayer(state: { currentStatus: GitStatusResult; statusCalls: number }) {
  const gitManager: GitManagerShape = {
    status: () =>
      Effect.sync(() => {
        state.statusCalls += 1;
        return state.currentStatus;
      }),
    readWorkingTreeDiff: () => Effect.die("readWorkingTreeDiff should not be called in this test"),
    summarizeDiff: () => Effect.die("summarizeDiff should not be called in this test"),
    resolvePullRequest: () => Effect.die("resolvePullRequest should not be called in this test"),
    preparePullRequestThread: () =>
      Effect.die("preparePullRequestThread should not be called in this test"),
    handoffThread: () => Effect.die("handoffThread should not be called in this test"),
    runStackedAction: () => Effect.die("runStackedAction should not be called in this test"),
  };

  return GitStatusBroadcasterLive.pipe(Layer.provide(Layer.succeed(GitManager, gitManager)));
}

const runBroadcasterTest = (
  state: { currentStatus: GitStatusResult; statusCalls: number },
  effect: Effect.Effect<void, GitManagerServiceError, GitStatusBroadcaster | Scope.Scope>,
) => effect.pipe(Effect.provide(makeTestLayer(state)), Effect.scoped, Effect.runPromise);

describe("GitStatusBroadcasterLive", () => {
  it("reuses the cached git status across repeated reads", async () => {
    const state = { currentStatus: baseStatus, statusCalls: 0 };

    await runBroadcasterTest(
      state,
      Effect.gen(function* () {
        const broadcaster = yield* GitStatusBroadcaster;

        const first = yield* broadcaster.getStatus({ cwd: "/repo" });
        const second = yield* broadcaster.getStatus({ cwd: "/repo" });

        expect(first).toEqual(baseStatus);
        expect(second).toEqual(baseStatus);
        expect(state.statusCalls).toBe(1);
      }),
    );
  });

  it("refreshes the cached snapshot after explicit invalidation", async () => {
    const state = { currentStatus: baseStatus, statusCalls: 0 };

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
        const refreshed = yield* broadcaster.refreshStatus("/repo");
        const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

        expect(initial).toEqual(baseStatus);
        expect(refreshed).toEqual(state.currentStatus);
        expect(cached).toEqual(state.currentStatus);
        expect(state.statusCalls).toBe(2);
      }),
    );
  });

  it("streams a status snapshot first and later refresh updates", async () => {
    const state = { currentStatus: baseStatus, statusCalls: 0 };

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
            aheadCount: baseStatus.aheadCount,
            behindCount: baseStatus.behindCount,
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
});
