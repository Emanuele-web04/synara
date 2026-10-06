import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ThreadId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref } from "effect";

import { TurnCheckpointCoordinator } from "../Services/TurnCheckpointCoordinator.ts";
import { TurnCheckpointCoordinatorLive } from "./TurnCheckpointCoordinator.ts";

it.layer(TurnCheckpointCoordinatorLive)("TurnCheckpointCoordinator", (it) => {
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
});
