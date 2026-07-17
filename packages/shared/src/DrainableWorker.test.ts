import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";

import {
  DrainableWorkerAdmissionError,
  makeDrainableWorker,
  startDrainableWorkerProducers,
} from "./DrainableWorker";

describe("makeDrainableWorker", () => {
  it.live("waits for work enqueued during active processing before draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeDrainableWorker((item: string) =>
          Effect.gen(function* () {
            if (item === "first") {
              yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseFirst);
            }

            if (item === "second") {
              yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseSecond);
            }

            processed.push(item);
          }),
        );

        yield* worker.enqueue("first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        yield* worker.enqueue("second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["first", "second"]);
      }),
    ),
  );

  it.live("bounds active plus queued work and reports typed overload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const processed: string[] = [];
        const worker = yield* makeDrainableWorker(
          (item: string) =>
            Effect.gen(function* () {
              if (item === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }
              processed.push(item);
            }),
          { capacity: 2 },
        );

        expect(yield* worker.enqueue("first")).toBe(true);
        yield* Deferred.await(firstStarted);
        yield* worker.tryEnqueue("second");

        const rejected = yield* Effect.result(worker.tryEnqueue("third"));
        expect(rejected._tag).toBe("Failure");
        if (rejected._tag === "Failure") {
          expect(rejected.failure).toEqual(
            new DrainableWorkerAdmissionError({
              reason: "overloaded",
              phase: "running",
              capacity: 2,
            }),
          );
        }
        expect(yield* worker.status).toEqual({
          phase: "running",
          outstanding: 2,
          capacity: 2,
        });

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* worker.drain;
        expect(processed).toEqual(["first", "second"]);
      }),
    ),
  );

  it.live("quiesces admission and drains accepted work before stopping", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const processed: string[] = [];
        const worker = yield* makeDrainableWorker(
          (item: string) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined).pipe(Effect.orDie);
              yield* Deferred.await(release);
              processed.push(item);
            }),
          { capacity: 1 },
        );

        expect(yield* worker.enqueue("accepted")).toBe(true);
        yield* Deferred.await(started);
        const stopFiber = yield* worker.stop.pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        expect(yield* worker.enqueue("late")).toBe(false);
        const rejected = yield* Effect.result(worker.tryEnqueue("late"));
        expect(rejected._tag).toBe("Failure");
        if (rejected._tag === "Failure") {
          expect(rejected.failure._tag).toBe("DrainableWorkerAdmissionError");
          expect(rejected.failure.reason).toBe("not-running");
        }
        expect((yield* worker.status).phase).toBe("draining");

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(stopFiber);
        expect(yield* worker.status).toEqual({
          phase: "stopped",
          outstanding: 0,
          capacity: 1,
        });
        expect(processed).toEqual(["accepted"]);
      }),
    ),
  );

  it.live("scope closure drains accepted work before interrupting the consumer", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const processed = yield* Deferred.make<void>();
      const worker = yield* makeDrainableWorker(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined).pipe(Effect.orDie);
          yield* Deferred.await(release);
          yield* Deferred.succeed(processed, undefined).pipe(Effect.orDie);
        }),
      ).pipe(Effect.provideService(Scope.Scope, scope));

      yield* worker.enqueue("accepted");
      yield* Deferred.await(started);
      const closeFiber = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      expect(closeFiber.pollUnsafe()).toBeUndefined();
      expect(yield* Deferred.isDone(processed)).toBe(false);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(closeFiber);
      expect(yield* Deferred.isDone(processed)).toBe(true);
    }),
  );

  it.live("stops producer subscriptions before draining accepted work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const itemStarted = yield* Deferred.make<void>();
        const order: string[] = [];
        const worker = yield* makeDrainableWorker(
          () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(itemStarted, undefined).pipe(Effect.orDie);
              yield* Effect.sleep("10 millis");
              order.push("item-finished");
            }),
          { capacity: 1 },
        );
        const producerScope = yield* Scope.make("sequential");

        yield* Scope.provide(
          startDrainableWorkerProducers(
            worker,
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  order.push("producer-stopped");
                }),
              );
            }),
          ),
          producerScope,
        );
        expect(yield* worker.enqueue("accepted")).toBe(true);
        yield* Deferred.await(itemStarted);

        yield* Scope.close(producerScope, Exit.void);
        expect(order).toEqual(["producer-stopped", "item-finished"]);
        expect((yield* worker.status).phase).toBe("stopped");
      }),
    ),
  );
});
