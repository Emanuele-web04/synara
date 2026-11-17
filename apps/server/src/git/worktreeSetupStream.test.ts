import { WsRpcError, type GitCreateDetachedWorktreeResult } from "@synara/contracts";
import { Cause, Deferred, Effect, Exit, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { makeDetachedWorktreeSetupStream } from "./worktreeSetupStream";

const result: GitCreateDetachedWorktreeResult = {
  worktree: { path: "/repo-worktrees/a", branch: "synara/a", ref: "main" },
};

const toError = (cause: Cause.Cause<unknown>) =>
  new WsRpcError({ message: `Failed to create detached worktree: ${Cause.pretty(cause)}` });

describe("makeDetachedWorktreeSetupStream", () => {
  it("delivers completed while the status refresh is still pending, then lets it finish", async () => {
    await Effect.gen(function* () {
      const log: string[] = [];
      const refreshStarted = yield* Deferred.make<void>();
      const refreshRelease = yield* Deferred.make<void>();
      const refreshFinished = yield* Deferred.make<void>();
      const stream = makeDetachedWorktreeSetupStream({
        progressId: "progress-1",
        create: (onPhase) =>
          Effect.gen(function* () {
            yield* onPhase("branch");
            yield* onPhase("worktree");
            yield* onPhase("copy-changes");
            log.push("create:done");
            return result;
          }),
        // Same shape as wsRpc's refreshGitStatusInBackground: detached and failure-swallowing.
        refreshStatusInBackground: Effect.sync(() => log.push("refresh:start")).pipe(
          Effect.andThen(Deferred.succeed(refreshStarted, undefined)),
          Effect.andThen(Deferred.await(refreshRelease)),
          Effect.andThen(Deferred.succeed(refreshFinished, undefined)),
          Effect.catchCause(() => Effect.void),
          Effect.forkDetach,
          Effect.asVoid,
        ),
        toError,
      });

      const events = yield* Stream.runCollect(stream);

      expect(events).toEqual([
        { kind: "phase_started", progressId: "progress-1", phase: "branch" },
        { kind: "phase_started", progressId: "progress-1", phase: "worktree" },
        { kind: "phase_started", progressId: "progress-1", phase: "copy-changes" },
        { kind: "completed", progressId: "progress-1", result },
      ]);
      // The stream ended without waiting for the refresh, which began only after
      // the creation finished and is still blocked.
      yield* Deferred.await(refreshStarted);
      expect(log).toEqual(["create:done", "refresh:start"]);
      expect(yield* Deferred.isDone(refreshFinished)).toBe(false);

      // Ending the stream did not interrupt the detached refresh.
      yield* Deferred.succeed(refreshRelease, undefined);
      yield* Deferred.await(refreshFinished);
    }).pipe(Effect.runPromise);
  });

  it("fails the stream and skips the refresh when creation fails", async () => {
    await Effect.gen(function* () {
      let refreshes = 0;
      const exit = yield* makeDetachedWorktreeSetupStream({
        progressId: null,
        create: (onPhase) =>
          onPhase("branch").pipe(Effect.andThen(Effect.fail("worktree add failed" as const))),
        refreshStatusInBackground: Effect.sync(() => {
          refreshes += 1;
        }),
        toError,
      }).pipe(Stream.runCollect, Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(WsRpcError);
          expect(error.value.message).toContain("worktree add failed");
        }
      }
      expect(refreshes).toBe(0);
    }).pipe(Effect.runPromise);
  });

  it("interrupts the creation, without refreshing, when the consumer stops", async () => {
    await Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let interrupted = false;
      let refreshes = 0;
      const consumer = yield* makeDetachedWorktreeSetupStream({
        progressId: null,
        create: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
        refreshStatusInBackground: Effect.sync(() => {
          refreshes += 1;
        }),
        toError,
      }).pipe(Stream.runDrain, Effect.forkChild);

      yield* Deferred.await(started);
      yield* Fiber.interrupt(consumer);

      expect(interrupted).toBe(true);
      expect(refreshes).toBe(0);
    }).pipe(Effect.scoped, Effect.runPromise);
  });
});
