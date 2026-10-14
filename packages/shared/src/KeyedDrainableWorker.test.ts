import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";

import { makeKeyedDrainableWorker } from "./KeyedDrainableWorker";

type Item = { key: string; id: string; priority?: number };
const options = {
  key: (item: Item) => item.key,
  concurrency: 2,
  capacity: 8,
  priority: (item: Item) => item.priority ?? 2,
};

describe("makeKeyedDrainableWorker", () => {
  it.live("keeps FIFO within a key without reserving permits for its queued followers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const otherDone = yield* Deferred.make<void>();
        const order: string[] = [];
        const worker = yield* makeKeyedDrainableWorker(
          (item: Item) =>
            Effect.gen(function* () {
              order.push(item.id);
              if (item.id === "a1") {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              }
              if (item.id === "b1") yield* Deferred.succeed(otherDone, undefined);
            }),
          options,
        );
        yield* worker.enqueue({ key: "a", id: "a1" });
        yield* Deferred.await(started);
        yield* worker.enqueue({ key: "a", id: "a2" });
        yield* worker.enqueue({ key: "a", id: "a3", priority: 0 });
        yield* worker.enqueue({ key: "b", id: "b1" });
        const progressed = yield* Deferred.await(otherDone).pipe(
          Effect.timeoutOption("100 millis"),
        );
        yield* Deferred.succeed(release, undefined);
        yield* worker.drain;
        expect(progressed._tag).toBe("Some");
        expect(order).toEqual(["a1", "b1", "a2", "a3"]);
      }),
    ),
  );

  it.live(
    "prioritizes ready lane heads while a later control item cannot overtake its own key",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const order: string[] = [];
          const worker = yield* makeKeyedDrainableWorker(
            (item: Item) =>
              Effect.gen(function* () {
                order.push(item.id);
                if (item.id === "blocked") {
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                }
              }),
            { ...options, concurrency: 1 },
          );
          yield* worker.enqueue({ key: "busy", id: "blocked" });
          yield* Deferred.await(started);
          yield* worker.enqueue({ key: "normal", id: "normal" });
          yield* worker.enqueue({ key: "normal", id: "same-key-control", priority: 0 });
          yield* worker.enqueue({ key: "user", id: "user", priority: 1 });
          yield* worker.enqueue({ key: "control", id: "control", priority: 0 });
          yield* Deferred.succeed(release, undefined);
          yield* worker.drain;
          expect(order).toEqual(["blocked", "control", "user", "normal", "same-key-control"]);
        }),
      ),
  );

  it.live(
    "bounds accepted work and drains keyed followers on scope closure despite a synchronous defect",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const order: string[] = [];
        const worker = yield* makeKeyedDrainableWorker(
          (item: Item) => {
            if (item.id === "defect") throw new Error("item defect");
            return Effect.gen(function* () {
              if (item.id === "blocked") {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              }
              order.push(item.id);
            });
          },
          { ...options, capacity: 3 },
        ).pipe(Effect.provideService(Scope.Scope, scope));
        yield* worker.enqueue({ key: "a", id: "blocked" });
        yield* Deferred.await(started);
        yield* worker.enqueue({ key: "a", id: "defect" });
        yield* worker.enqueue({ key: "a", id: "after" });
        const overload = yield* Effect.result(worker.tryEnqueue({ key: "b", id: "excess" }));
        expect(overload._tag).toBe("Failure");
        expect((yield* worker.status).outstanding).toBe(3);
        const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(yield* worker.enqueue({ key: "b", id: "late" })).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(closing);
        expect(order).toEqual(["blocked", "after"]);
        expect((yield* worker.status).outstanding).toBe(0);
      }),
  );
  it.live("limits active distinct keys and releases a cancelled capacity waiter", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const aStarted = yield* Deferred.make<void>();
        const bStarted = yield* Deferred.make<void>();
        const cStarted = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const processed: string[] = [];
        const worker = yield* makeKeyedDrainableWorker(
          (item: Item) =>
            Effect.gen(function* () {
              if (item.key === "a" || item.key === "b") {
                yield* Deferred.succeed(item.key === "a" ? aStarted : bStarted, undefined);
                yield* Deferred.await(release);
              } else yield* Deferred.succeed(cStarted, undefined);
              processed.push(item.id);
            }),
          { ...options, capacity: 3 },
        );
        yield* worker.enqueue({ key: "a", id: "a" });
        yield* worker.enqueue({ key: "b", id: "b" });
        yield* Deferred.await(aStarted);
        yield* Deferred.await(bStarted);
        yield* worker.enqueue({ key: "c", id: "c" });
        const waiting = yield* worker.enqueue({ key: "d", id: "cancelled" }).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(waiting);
        const thirdStartedEarly = yield* Deferred.await(cStarted).pipe(
          Effect.timeoutOption("100 millis"),
        );
        yield* Deferred.succeed(release, undefined);
        yield* worker.drain;
        expect(thirdStartedEarly._tag).toBe("None");
        expect(processed.toSorted()).toEqual(["a", "b", "c"]);
        expect((yield* worker.status).outstanding).toBe(0);
      }),
    ),
  );
  it.live("contains an item interruption without losing its only consumer", () =>
    Effect.gen(function* () {
      // A raw scope keeps the broken-worker RED bounded: a dead consumer cannot
      // drain its follower, so closing that scope would reproduce an infinite shutdown.
      const scope = yield* Scope.make();
      const processed: string[] = [];
      const worker = yield* makeKeyedDrainableWorker(
        (item: Item) =>
          item.id === "interrupt"
            ? Effect.interrupt
            : Effect.sync(() => {
                processed.push(item.id);
              }),
        { ...options, concurrency: 1 },
      ).pipe(Effect.provideService(Scope.Scope, scope));
      yield* worker.enqueue({ key: "a", id: "interrupt" });
      yield* worker.enqueue({ key: "a", id: "follower" });
      const drained = yield* worker.drain.pipe(Effect.timeoutOption("300 millis"));
      if (drained._tag === "Some") yield* Scope.close(scope, Exit.void);
      expect(drained._tag).toBe("Some");
      expect(processed).toEqual(["follower"]);
    }),
  );

  it.live(
    "reschedules bounded work quanta without reserving another slot or starving a ready key",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const counts = new Map<string, number>();
          const order: string[] = [];
          const worker = yield* makeKeyedDrainableWorker(
            (item: Item) =>
              Effect.gen(function* () {
                const count = (counts.get(item.key) ?? 0) + 1;
                counts.set(item.key, count);
                order.push(`${item.key}${count}`);
                if (item.key === "a" && count === 1) {
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                }
              }),
            {
              ...options,
              capacity: 2,
              concurrency: 1,
              shouldContinue: (item: Item) => item.key === "a" && counts.get(item.key)! < 3,
            },
          );
          yield* worker.enqueue({ key: "a", id: "a" });
          yield* Deferred.await(started);
          yield* worker.enqueue({ key: "b", id: "b" });
          expect((yield* worker.status).outstanding).toBe(2);
          yield* Deferred.succeed(release, undefined);
          yield* worker.drain;
          expect(order).toEqual(["a1", "b1", "a2", "a3"]);
          expect((yield* worker.status).outstanding).toBe(0);
        }),
      ),
  );

  it.live(
    "reconsiders continuation priority without letting a same-key control follower overtake it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const order: string[] = [];
          let quanta = 0;
          const worker = yield* makeKeyedDrainableWorker(
            (item: Item) =>
              Effect.gen(function* () {
                order.push(item.id === "main" ? `main${++quanta}` : item.id);
                if (item.id === "main") {
                  item.priority = 2;
                  if (quanta === 1) {
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(release);
                  }
                }
              }),
            {
              ...options,
              capacity: 3,
              concurrency: 1,
              shouldContinue: (item: Item) => item.id === "main" && quanta < 3,
            },
          );
          yield* worker.enqueue({ key: "a", id: "main", priority: 0 });
          yield* Deferred.await(started);
          yield* worker.enqueue({ key: "b", id: "user", priority: 1 });
          yield* worker.enqueue({ key: "a", id: "control-follower", priority: 0 });
          yield* Deferred.succeed(release, undefined);
          yield* worker.drain;
          expect(order).toEqual(["main1", "user", "main2", "main3", "control-follower"]);
          expect((yield* worker.status).outstanding).toBe(0);
        }),
      ),
  );

  it.live("contains a throwing continuation predicate without losing its consumer or slot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const order: string[] = [];
        const worker = yield* makeKeyedDrainableWorker(
          (item: Item) =>
            Effect.sync(() => {
              order.push(item.id);
            }),
          {
            ...options,
            capacity: 2,
            concurrency: 1,
            shouldContinue: (item: Item) => {
              if (item.id === "defect") throw new Error("continuation defect");
              return false;
            },
          },
        );
        yield* worker.enqueue({ key: "a", id: "defect" });
        yield* worker.enqueue({ key: "a", id: "follower" });
        yield* worker.drain;
        expect(order).toEqual(["defect", "follower"]);
        expect((yield* worker.status).outstanding).toBe(0);
      }),
    ),
  );
});
