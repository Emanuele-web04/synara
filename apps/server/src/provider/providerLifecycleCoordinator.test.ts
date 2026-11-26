// FILE: providerLifecycleCoordinator.test.ts
// Purpose: Verifies per-thread lifecycle serialization and generation ownership rules.
// Layer: Provider lifecycle unit tests
// Depends on: makeProviderLifecycleCoordinator.

import { ThreadId } from "@synara/contracts";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeProviderLifecycleCoordinator } from "./providerLifecycleCoordinator.ts";

const threadId = ThreadId.makeUnsafe("thread-lifecycle-coordinator");

describe("makeProviderLifecycleCoordinator", () => {
  it("keeps the old generation through preparation and does not rotate on rejection", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        coordinator.adoptCurrent(threadId, "old");
        const result = yield* coordinator
          .run(
            threadId,
            () => Effect.die("must not start"),
            Effect.gen(function* () {
              expect(coordinator.currentGeneration(threadId)).toBe("old");
              yield* Effect.yieldNow;
              expect(coordinator.currentGeneration(threadId)).toBe("old");
              return yield* Effect.fail("busy");
            }),
          )
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(coordinator.currentGeneration(threadId)).toBe("old");
      }),
    );
  });

  it("publishes the run generation for the duration of a committed run", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        const started = yield* coordinator.run(threadId, (lease) =>
          Effect.sync(() => {
            expect(coordinator.currentGeneration(threadId)).toBe(lease.generation);
            lease.commit();
            return lease.generation;
          }),
        );

        expect(coordinator.currentGeneration(threadId)).toBe(started);
      }),
    );
  });

  it("clears the generation when an uncommitted run succeeds on a fresh thread", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        yield* coordinator.run(threadId, () => Effect.void);

        expect(coordinator.currentGeneration(threadId)).toBeUndefined();
      }),
    );
  });

  it("restores the previous generation when a run fails before taking ownership", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        const live = yield* coordinator.run(threadId, (lease) =>
          Effect.sync(() => {
            lease.commit();
            return lease.generation;
          }),
        );

        const result = yield* Effect.result(
          coordinator.run(threadId, () => Effect.fail("start failed" as const)),
        );

        expect(result._tag).toBe("Failure");
        expect(coordinator.currentGeneration(threadId)).toBe(live);
      }),
    );
  });

  it("keeps an owned generation when the run is interrupted after committing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        const committed = yield* Deferred.make<string>();
        const fiber = yield* coordinator
          .run(threadId, (lease) =>
            Effect.sync(() => lease.commit()).pipe(
              Effect.andThen(Deferred.succeed(committed, lease.generation)),
              Effect.andThen(Effect.never),
            ),
          )
          .pipe(Effect.forkChild);

        const generation = yield* Deferred.await(committed);
        yield* Fiber.interrupt(fiber);

        // The started runtime outlives the interrupted request, so rewinding
        // here would orphan it exactly like an uncommitted run.
        expect(coordinator.currentGeneration(threadId)).toBe(generation);
      }),
    );
  });

  for (const mode of ["urgent", "retirement", "legacy-urgent"] as const) {
    it(`bounds a contended ${mode} operation without changing legacy urgent fallback`, async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const coordinator = makeProviderLifecycleCoordinator();
          coordinator.adoptCurrent(threadId, "current");
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const holder = yield* coordinator
            .runCurrent(threadId, () =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          let calls = 0;
          const operation = Effect.sync(() => {
            calls += 1;
            return "completed";
          });
          const timeout = Effect.fail("contended" as const);
          const now = Date.now();
          const clock = vi
            .spyOn(Date, "now")
            .mockReturnValueOnce(now)
            .mockReturnValue(now + 6000);
          const result = yield* (
            mode === "retirement"
              ? coordinator.run(threadId, () => operation, undefined, timeout)
              : coordinator.runCurrentUrgent(
                  threadId,
                  () => operation,
                  mode === "urgent" ? timeout : undefined,
                )
          ).pipe(
            Effect.result,
            Effect.ensuring(Effect.sync(() => clock.mockRestore())),
            Effect.ensuring(Deferred.succeed(release, undefined)),
          );
          yield* Fiber.join(holder);
          expect(result._tag).toBe(mode === "legacy-urgent" ? "Success" : "Failure");
          expect(calls).toBe(mode === "legacy-urgent" ? 1 : 0);
          expect(coordinator.currentGeneration(threadId)).toBe("current");
          expect(yield* coordinator.runCurrent(threadId, () => Effect.succeed("reacquired"))).toBe(
            "reacquired",
          );
        }),
      );
    });
  }

  it("retires the generation for a stopped thread", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        yield* coordinator.run(threadId, (lease) => Effect.sync(() => lease.commit()));
        yield* coordinator.run(threadId, (lease) => Effect.sync(() => lease.retire()));

        expect(coordinator.currentGeneration(threadId)).toBeUndefined();
      }),
    );
  });
});
