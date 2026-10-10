import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ThreadId } from "@synara/contracts";
import { assert, it as effectIt } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Option, Ref } from "effect";

import { TurnCheckpointCoordinator } from "../Services/TurnCheckpointCoordinator.ts";
import { TurnCheckpointCoordinatorLive } from "./TurnCheckpointCoordinator.ts";

effectIt.layer(TurnCheckpointCoordinatorLive)("TurnCheckpointCoordinator", (it) => {
  it.effect("keeps a turn activation behind a validated checkpoint mutation", () =>
    Effect.gen(function* () {
      const coordinator = yield* TurnCheckpointCoordinator;
      const threadId = ThreadId.makeUnsafe("thread-revert-turn-exclusion");
      const validationFinished = yield* Deferred.make<void>();
      const resumeCheckpointMutation = yield* Deferred.make<void>();
      const turnActivationAttempted = yield* Deferred.make<void>();
      const order = yield* Ref.make<ReadonlyArray<string>>([]);

      const revertFiber = yield* coordinator
        .withThreadLease(
          threadId,
          Effect.gen(function* () {
            yield* Deferred.succeed(validationFinished, undefined);
            yield* Deferred.await(resumeCheckpointMutation);
            yield* Ref.update(order, (entries) => [...entries, "checkpoint-mutation"]);
          }),
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(validationFinished);
      const turnFiber = yield* Effect.gen(function* () {
        yield* Deferred.succeed(turnActivationAttempted, undefined);
        yield* coordinator.withThreadLease(
          threadId,
          Ref.update(order, (entries) => [...entries, "turn-activation"]),
        );
      }).pipe(Effect.forkChild);

      yield* Deferred.await(turnActivationAttempted);
      yield* Effect.yieldNow;
      assert.deepEqual(yield* Ref.get(order), []);

      yield* Deferred.succeed(resumeCheckpointMutation, undefined);
      yield* Fiber.join(revertFiber);
      yield* Fiber.join(turnFiber);

      assert.deepEqual(yield* Ref.get(order), ["checkpoint-mutation", "turn-activation"]);
    }),
  );
  it.effect(
    "keeps another thread's baseline behind a workspace restore while unrelated work proceeds",
    () =>
      Effect.gen(function* () {
        const coordinator = yield* TurnCheckpointCoordinator;
        assert.isFunction(coordinator.withWorkspaceLease);
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const order = yield* Ref.make<ReadonlyArray<string>>([]);
        const restore = yield* coordinator
          .withThreadLease(
            ThreadId.makeUnsafe("workspace-restore-owner"),
            coordinator.withWorkspaceLease(
              "/checkpoint-workspace/shared",
              Deferred.succeed(held, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Ref.update(order, (entries) => [...entries, "restore"])),
              ),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(held);
        const baseline = yield* coordinator
          .withThreadLease(
            ThreadId.makeUnsafe("workspace-baseline-owner"),
            coordinator.withWorkspaceLease(
              "/checkpoint-workspace/shared/../shared",
              Ref.update(order, (entries) => [...entries, "baseline"]),
            ),
          )
          .pipe(Effect.forkChild);
        try {
          yield* coordinator.withWorkspaceLease(
            "/checkpoint-workspace/other",
            Ref.update(order, (entries) => [...entries, "other"]),
          );
          assert.deepEqual(yield* Ref.get(order), ["other"]);
        } finally {
          yield* Deferred.succeed(release, undefined);
        }
        yield* Fiber.join(restore);
        yield* Fiber.join(baseline);
        assert.deepEqual(yield* Ref.get(order), ["other", "restore", "baseline"]);
      }),
  );

  it.effect("shares the existing workspace lock with a resolved identity lease", () =>
    Effect.gen(function* () {
      const coordinator = yield* TurnCheckpointCoordinator;
      assert.isFunction(coordinator.withWorkspaceIdentityLease);
      const identity = yield* coordinator.resolveWorkspaceIdentity("/checkpoint-identity/shared");
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const entered = yield* Ref.make(false);
      const owner = yield* coordinator
        .withWorkspaceLease(
          "/checkpoint-identity/shared/../shared",
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const pinned = yield* coordinator
        .withWorkspaceIdentityLease(identity, Ref.set(entered, true))
        .pipe(Effect.forkChild);
      try {
        yield* Effect.yieldNow;
        assert.isFalse(yield* Ref.get(entered));
      } finally {
        yield* Deferred.succeed(release, undefined);
      }
      yield* Fiber.join(owner);
      yield* Fiber.join(pinned);
      assert.isTrue(yield* Ref.get(entered));
    }),
  );

  it.effect(
    "shares one checkout identity for nested directories while preserving separate worktrees",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* TurnCheckpointCoordinator;
          assert.isFunction(coordinator.resolveWorkspaceIdentity);
          const cwd = yield* Effect.acquireRelease(
            Effect.tryPromise(() =>
              fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-checkout-identity-")),
            ).pipe(Effect.orDie),
            (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
          );
          const nested = path.join(cwd, "nested", "deeper");
          const worktree = path.join(cwd, "linked-worktree");
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(cwd, ".git"));
            await fs.mkdir(nested, { recursive: true });
            await fs.mkdir(worktree);
            await fs.writeFile(
              path.join(worktree, ".git"),
              `gitdir: ${path.join(cwd, ".git", "worktrees", "linked")}\n`,
            );
          });
          assert.equal(
            yield* coordinator.resolveWorkspaceIdentity(cwd),
            yield* coordinator.resolveWorkspaceIdentity(nested),
          );
          assert.notEqual(
            yield* coordinator.resolveWorkspaceIdentity(cwd),
            yield* coordinator.resolveWorkspaceIdentity(worktree),
          );
          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const calls = yield* Ref.make<ReadonlyArray<string>>([]);
          const restore = yield* coordinator
            .withWorkspaceLease(
              cwd,
              Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(held);
          const capture = yield* coordinator
            .withWorkspaceLease(
              nested,
              Ref.update(calls, (entries) => [...entries, "nested"]),
            )
            .pipe(Effect.forkChild);
          try {
            yield* coordinator.withWorkspaceLease(
              worktree,
              Ref.update(calls, (entries) => [...entries, "worktree"]),
            );
            assert.deepEqual(yield* Ref.get(calls), ["worktree"]);
          } finally {
            yield* Deferred.succeed(release, undefined);
          }
          yield* Fiber.join(restore);
          yield* Fiber.join(capture);
          assert.deepEqual(yield* Ref.get(calls), ["worktree", "nested"]);
        }),
      ),
  );

  it.effect(
    "cancels a queued workspace baseline without releasing the active restore's lease",
    () =>
      Effect.gen(function* () {
        const coordinator = yield* TurnCheckpointCoordinator;
        assert.isFunction(coordinator.withWorkspaceLease);
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const restore = yield* coordinator
          .withWorkspaceLease(
            "/checkpoint-workspace/cancel",
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(held);
        const cancelled = yield* coordinator
          .withWorkspaceLease(
            "/checkpoint-workspace/cancel",
            Ref.update(calls, (entries) => [...entries, "cancelled"]),
          )
          .pipe(Effect.forkChild);
        yield* Fiber.interrupt(cancelled);
        const replacement = yield* coordinator
          .withWorkspaceLease(
            "/checkpoint-workspace/cancel",
            Ref.update(calls, (entries) => [...entries, "replacement"]),
          )
          .pipe(Effect.forkChild);
        try {
          yield* coordinator.withWorkspaceLease("/checkpoint-workspace/independent", Effect.void);
          assert.deepEqual(yield* Ref.get(calls), []);
        } finally {
          yield* Deferred.succeed(release, undefined);
        }
        yield* Fiber.join(restore);
        yield* Fiber.join(replacement);
        assert.deepEqual(yield* Ref.get(calls), ["replacement"]);
      }),
  );

  effectIt.live(
    "admits concurrent provider activations but gives a workspace writer exclusive ownership",
    () =>
      Effect.gen(function* () {
        const coordinator = yield* TurnCheckpointCoordinator;
        const cwd = "/checkpoint-workspace/activation";
        const firstEntered = yield* Deferred.make<void>();
        const secondEntered = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();
        const writerEntered = yield* Deferred.make<void>();
        const releaseWriter = yield* Deferred.make<void>();
        const lateEntered = yield* Deferred.make<void>();
        const first = yield* coordinator
          .withWorkspaceActivationLease(
            cwd,
            Deferred.succeed(firstEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstEntered);
        const second = yield* coordinator
          .withWorkspaceActivationLease(
            `${cwd}/../activation`,
            Deferred.succeed(secondEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseSecond)),
            ),
          )
          .pipe(Effect.forkChild);
        try {
          assert.isTrue(
            Option.isSome(
              yield* Deferred.await(secondEntered).pipe(Effect.timeoutOption(Duration.seconds(1))),
            ),
          );
          const writer = yield* coordinator
            .withWorkspaceLease(
              cwd,
              Deferred.succeed(writerEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseWriter)),
              ),
            )
            .pipe(Effect.forkChild);
          assert.isTrue(
            Option.isNone(
              yield* Deferred.await(writerEntered).pipe(Effect.timeoutOption(Duration.millis(50))),
            ),
          );
          yield* Deferred.succeed(releaseFirst, undefined);
          assert.isTrue(
            Option.isNone(
              yield* Deferred.await(writerEntered).pipe(Effect.timeoutOption(Duration.millis(50))),
            ),
          );
          yield* Deferred.succeed(releaseSecond, undefined);
          yield* Deferred.await(writerEntered);
          const late = yield* coordinator
            .withWorkspaceActivationLease(cwd, Deferred.succeed(lateEntered, undefined))
            .pipe(Effect.forkChild);
          assert.isTrue(
            Option.isNone(
              yield* Deferred.await(lateEntered).pipe(Effect.timeoutOption(Duration.millis(50))),
            ),
          );
          yield* Deferred.succeed(releaseWriter, undefined);
          yield* Fiber.join(writer);
          yield* Fiber.join(late);
          assert.isTrue(yield* Deferred.isDone(lateEntered));
        } finally {
          yield* Deferred.succeed(releaseFirst, undefined);
          yield* Deferred.succeed(releaseSecond, undefined);
          yield* Deferred.succeed(releaseWriter, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
        }
      }).pipe(Effect.provide(TurnCheckpointCoordinatorLive)),
  );

  it.effect("releases a cancelled activation so a waiting workspace restore can proceed", () =>
    Effect.gen(function* () {
      const coordinator = yield* TurnCheckpointCoordinator;
      const held = yield* Deferred.make<void>();
      const writerEntered = yield* Deferred.make<void>();
      const reader = yield* coordinator
        .withWorkspaceActivationLease(
          "/checkpoint-workspace/activation-cancel",
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const writer = yield* coordinator
        .withWorkspaceLease(
          "/checkpoint-workspace/activation-cancel",
          Deferred.succeed(writerEntered, undefined),
        )
        .pipe(Effect.forkChild);
      yield* Fiber.interrupt(reader);
      yield* Fiber.join(writer);
      assert.isTrue(yield* Deferred.isDone(writerEntered));
      yield* coordinator.withWorkspaceActivationLease(
        "/checkpoint-workspace/activation-cancel",
        Effect.void,
      );
    }),
  );

  it.effect("cancels a queued activation without releasing the active workspace restore", () =>
    Effect.gen(function* () {
      const coordinator = yield* TurnCheckpointCoordinator;
      const cwd = "/checkpoint-workspace/queued-activation";
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const writer = yield* coordinator
        .withWorkspaceLease(
          cwd,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const cancelled = yield* coordinator
        .withWorkspaceActivationLease(
          cwd,
          Ref.update(calls, (entries) => [...entries, "cancelled"]),
        )
        .pipe(Effect.forkChild);
      yield* Fiber.interrupt(cancelled);
      const replacement = yield* coordinator
        .withWorkspaceActivationLease(
          cwd,
          Ref.update(calls, (entries) => [...entries, "replacement"]),
        )
        .pipe(Effect.forkChild);
      try {
        yield* coordinator.withWorkspaceActivationLease(
          "/checkpoint-workspace/other-activation",
          Effect.void,
        );
        assert.deepEqual(yield* Ref.get(calls), []);
      } finally {
        yield* Deferred.succeed(release, undefined);
      }
      yield* Fiber.join(writer);
      yield* Fiber.join(replacement);
      assert.deepEqual(yield* Ref.get(calls), ["replacement"]);
    }),
  );
});
