import { Deferred, Effect, Exit, Fiber, Scope, Semaphore } from "effect";

export interface KeyedSingleFlightCacheOptions<A> {
  readonly maxEntries: number;
  readonly ttlMs: number | ((value: A) => number);
}

export interface KeyedSingleFlightCache<A, E> {
  /**
   * Returns a fresh cached value or joins one independently-owned computation for the key.
   * Cancelling one caller only cancels the computation when it was the final waiter.
   */
  readonly get: <R>(key: string, load: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Invalidates one key without allowing older work to repopulate it. */
  readonly invalidate: (key: string) => Effect.Effect<void>;
  /** Invalidates only matching keys, including keys which currently have in-flight work. */
  readonly invalidateWhere: (predicate: (key: string) => boolean) => Effect.Effect<void>;
  /** Invalidates every value while allowing existing waiters to finish their current work. */
  readonly invalidateAll: Effect.Effect<void>;
  /** Test and diagnostics hook; not used to coordinate application behavior. */
  readonly size: Effect.Effect<{ readonly cached: number; readonly inFlight: number }>;
}

interface CachedValue<A> {
  readonly value: A;
  readonly expiresAt: number;
  readonly generation: number;
}

interface InFlight<A, E> {
  readonly deferred: Deferred.Deferred<A, E>;
  readonly generation: number;
  readonly inFlightKey: string;
  fiber: Fiber.Fiber<void, never> | null;
  waiters: number;
  settled: boolean;
}

/**
 * A small bounded cache and single-flight primitive for remote subprocess work.
 *
 * Work runs in a cache-owned scope instead of the first request fiber. This prevents an owner
 * cancellation from poisoning healthy joiners, while the waiter count still interrupts remote
 * work as soon as nobody needs it. Monotonic generations prevent invalidated work from publishing
 * a stale result, even when a replacement request starts before the old process exits.
 */
export const makeKeyedSingleFlightCache = <A, E>(
  options: KeyedSingleFlightCacheOptions<A>,
): Effect.Effect<KeyedSingleFlightCache<A, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const maxEntries = Math.max(1, Math.floor(options.maxEntries));
    const cache = new Map<string, CachedValue<A>>();
    const inFlight = new Map<string, InFlight<A, E>>();
    const generations = new Map<string, number>();
    const lock = yield* Semaphore.make(1);
    const workerScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));
    let nextGeneration = 0;

    const generationFor = (key: string): number => {
      const current = generations.get(key);
      if (current !== undefined) return current;
      const allocated = ++nextGeneration;
      generations.set(key, allocated);
      return allocated;
    };

    const releaseGenerationIfUnused = (key: string, generation: number): void => {
      if (generations.get(key) !== generation) return;
      if (cache.get(key)?.generation === generation) return;
      for (const entry of inFlight.values()) {
        if (entry.generation === generation && entry.inFlightKey.endsWith(`\u0000${key}`)) return;
      }
      generations.delete(key);
    };

    const deleteCached = (key: string): void => {
      const existing = cache.get(key);
      if (!existing) return;
      cache.delete(key);
      releaseGenerationIfUnused(key, existing.generation);
    };

    const pruneForInsert = (now: number): void => {
      for (const [key, entry] of cache) {
        if (entry.expiresAt <= now) deleteCached(key);
      }
      while (cache.size >= maxEntries) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) break;
        deleteCached(oldestKey);
      }
    };

    const finish = (key: string, entry: InFlight<A, E>, exit: Exit.Exit<A, E>) =>
      Effect.gen(function* () {
        // A functional TTL is extension code and may throw. Resolve it before mutating the
        // in-flight entry, then treat a defective callback as "do not cache" so every waiter still
        // receives the completed load instead of being left on an orphaned Deferred.
        const ttlMs = Exit.isSuccess(exit)
          ? yield* Effect.sync(() => {
              try {
                const configured =
                  typeof options.ttlMs === "function" ? options.ttlMs(exit.value) : options.ttlMs;
                return Number.isNaN(configured) ? 0 : Math.max(0, configured);
              } catch {
                return null;
              }
            })
          : null;

        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            entry.settled = true;
            if (inFlight.get(entry.inFlightKey) === entry) {
              inFlight.delete(entry.inFlightKey);
            }
            const published =
              Exit.isSuccess(exit) && ttlMs !== null && generations.get(key) === entry.generation;
            if (published) {
              const now = Date.now();
              pruneForInsert(now);
              cache.set(key, {
                value: exit.value,
                expiresAt: now + ttlMs,
                generation: entry.generation,
              });
            } else {
              releaseGenerationIfUnused(key, entry.generation);
            }
            yield* Deferred.done(entry.deferred, exit);
          }),
        );
      });

    const releaseWaiter = (key: string, entry: InFlight<A, E>) =>
      lock
        .withPermits(1)(
          Effect.sync(() => {
            entry.waiters = Math.max(0, entry.waiters - 1);
            if (entry.waiters !== 0 || entry.settled) return null;
            if (inFlight.get(entry.inFlightKey) === entry) {
              inFlight.delete(entry.inFlightKey);
            }
            // Removing the current generation makes stale publication impossible before a
            // replacement request allocates its globally unique generation.
            if (generations.get(key) === entry.generation) {
              generations.delete(key);
            }
            return entry.fiber;
          }),
        )
        .pipe(Effect.flatMap((fiber) => (fiber === null ? Effect.void : Fiber.interrupt(fiber))));

    const get: KeyedSingleFlightCache<A, E>["get"] = (key, load) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const selection = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              const now = Date.now();
              const cached = cache.get(key);
              if (cached && cached.expiresAt <= now) {
                deleteCached(key);
              } else if (cached && generations.get(key) === cached.generation) {
                // Touch on read so the bounded map behaves as a tiny LRU rather than evicting a
                // frequently used key solely because it was inserted early.
                cache.delete(key);
                cache.set(key, cached);
                return { _tag: "cached" as const, value: cached.value };
              }

              const generation = generationFor(key);
              const inFlightKey = `${generation}\u0000${key}`;
              const existing = inFlight.get(inFlightKey);
              if (existing) {
                existing.waiters += 1;
                return { _tag: "in-flight" as const, entry: existing };
              }

              const deferred = yield* Deferred.make<A, E>();
              const start = yield* Deferred.make<void>();
              const entry: InFlight<A, E> = {
                deferred,
                generation,
                inFlightKey,
                fiber: null,
                waiters: 1,
                settled: false,
              };
              inFlight.set(inFlightKey, entry);
              entry.fiber = yield* Effect.uninterruptibleMask((restoreWorker) =>
                Effect.gen(function* () {
                  yield* Deferred.await(start);
                  const exit = yield* Effect.exit(restoreWorker(load));
                  yield* finish(key, entry, exit);
                }),
              ).pipe(Effect.forkIn(workerScope));
              yield* Deferred.succeed(start, undefined);
              return { _tag: "in-flight" as const, entry };
            }),
          );

          if (selection._tag === "cached") return selection.value;
          return yield* restore(Deferred.await(selection.entry.deferred)).pipe(
            Effect.ensuring(releaseWaiter(key, selection.entry)),
          );
        }),
      );

    const invalidate = (key: string) =>
      lock.withPermits(1)(
        Effect.sync(() => {
          cache.delete(key);
          generations.delete(key);
        }),
      );

    const invalidateWhere = (predicate: (key: string) => boolean) =>
      lock.withPermits(1)(
        Effect.sync(() => {
          const keys = new Set<string>([...cache.keys(), ...generations.keys()]);
          for (const entry of inFlight.values()) {
            const separator = entry.inFlightKey.indexOf("\u0000");
            if (separator >= 0) keys.add(entry.inFlightKey.slice(separator + 1));
          }
          for (const key of keys) {
            if (!predicate(key)) continue;
            cache.delete(key);
            generations.delete(key);
          }
        }),
      );

    return {
      get,
      invalidate,
      invalidateWhere,
      invalidateAll: lock.withPermits(1)(
        Effect.sync(() => {
          cache.clear();
          generations.clear();
        }),
      ),
      size: lock.withPermits(1)(
        Effect.sync(() => ({ cached: cache.size, inFlight: inFlight.size })),
      ),
    };
  });
