import { describe, expect, it } from "vitest";
import { Deferred, Effect, Fiber } from "effect";

import { makeKeyedSingleFlightCache } from "./KeyedSingleFlightCache";

describe("KeyedSingleFlightCache", () => {
  it("keeps a healthy joiner alive when the first waiter is interrupted", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const cache = yield* makeKeyedSingleFlightCache<number, never>({
            maxEntries: 4,
            ttlMs: 1_000,
          });
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let executions = 0;
          const load = Effect.gen(function* () {
            executions += 1;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return 42;
          });

          const owner = yield* cache.get("same", load).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          const joiner = yield* cache.get("same", load).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Fiber.interrupt(owner);
          yield* Deferred.succeed(release, undefined);

          return { executions, value: yield* Fiber.join(joiner) };
        }),
      ),
    );

    expect(result).toEqual({ executions: 1, value: 42 });
  });

  it("interrupts independently-owned work after its final waiter leaves", async () => {
    const interrupted = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const cache = yield* makeKeyedSingleFlightCache<number, never>({
            maxEntries: 4,
            ttlMs: 1_000,
          });
          const started = yield* Deferred.make<void>();
          const cancelled = yield* Deferred.make<void>();
          const load = Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }).pipe(
            Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid)),
          );

          const waiter = yield* cache.get("abandoned", load).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(waiter);
          yield* Deferred.await(cancelled);
          return true;
        }),
      ),
    );

    expect(interrupted).toBe(true);
  });

  it("does not let invalidated work overwrite its replacement", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const cache = yield* makeKeyedSingleFlightCache<string, never>({
            maxEntries: 4,
            ttlMs: 1_000,
          });
          const oldStarted = yield* Deferred.make<void>();
          const releaseOld = yield* Deferred.make<void>();
          const old = yield* cache
            .get(
              "repository",
              Effect.gen(function* () {
                yield* Deferred.succeed(oldStarted, undefined);
                yield* Deferred.await(releaseOld);
                return "old";
              }),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(oldStarted);

          yield* cache.invalidate("repository");
          const replacement = yield* cache.get("repository", Effect.succeed("new"));
          yield* Deferred.succeed(releaseOld, undefined);
          yield* Fiber.join(old);
          const cached = yield* cache.get("repository", Effect.succeed("unexpected"));
          return { replacement, cached };
        }),
      ),
    );

    expect(result).toEqual({ replacement: "new", cached: "new" });
  });

  it("bounds cached values and invalidates only matching keys", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const cache = yield* makeKeyedSingleFlightCache<number, never>({
            maxEntries: 2,
            ttlMs: 1_000,
          });
          yield* cache.get("acme/one:open", Effect.succeed(1));
          yield* cache.get("acme/two:open", Effect.succeed(2));
          yield* cache.get("acme/three:open", Effect.succeed(3));
          const before = yield* cache.size;
          yield* cache.invalidateWhere((key) => key.startsWith("acme/two:"));
          const after = yield* cache.size;
          return { before, after };
        }),
      ),
    );

    expect(result.before).toEqual({ cached: 2, inFlight: 0 });
    expect(result.after).toEqual({ cached: 1, inFlight: 0 });
  });

  it("completes waiters and skips caching when a functional TTL throws", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let loads = 0;
          const cache = yield* makeKeyedSingleFlightCache<number, never>({
            maxEntries: 2,
            ttlMs: () => {
              throw new Error("broken TTL callback");
            },
          });
          const load = Effect.sync(() => ++loads);

          const first = yield* cache.get("ttl-defect", load);
          const second = yield* cache.get("ttl-defect", load);
          return { first, second, loads, size: yield* cache.size };
        }),
      ),
    );

    expect(result).toEqual({ first: 1, second: 2, loads: 2, size: { cached: 0, inFlight: 0 } });
  });
});
