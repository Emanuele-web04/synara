import { randomUUID } from "node:crypto";

import type { ThreadId } from "@synara/contracts";
import { Effect, Exit } from "effect";
import * as Semaphore from "effect/Semaphore";

export interface ProviderLifecycleLease {
  readonly generation: string;
  readonly isCurrent: () => boolean;
  readonly adopt: (generation: string) => void;
  readonly retire: () => void;
}

export interface ProviderLifecycleCoordinator {
  readonly run: <A, E, R>(
    threadId: ThreadId,
    operation: (lease: ProviderLifecycleLease) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly runCurrent: <A, E, R>(
    threadId: ThreadId,
    operation: (generation: string | undefined) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly adoptCurrent: (threadId: ThreadId, generation: string) => void;
  readonly currentGeneration: (threadId: ThreadId) => string | undefined;
}

/** Serializes provider lifecycle mutations per thread and gives each mutation a unique epoch. */
export function makeProviderLifecycleCoordinator(): ProviderLifecycleCoordinator {
  const locks = new Map<
    ThreadId,
    { readonly semaphore: Semaphore.Semaphore; users: number }
  >();
  const currentGenerations = new Map<ThreadId, string>();

  const withThreadLock = <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      let entry = locks.get(threadId);
      if (entry === undefined) {
        entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        locks.set(threadId, entry);
      }
      entry.users += 1;
      const acquiredEntry = entry;

      return acquiredEntry.semaphore
        .withPermits(1)(effect)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              acquiredEntry.users -= 1;
              if (acquiredEntry.users === 0 && locks.get(threadId) === acquiredEntry) {
                locks.delete(threadId);
              }
            }),
          ),
        );
    });

  const run: ProviderLifecycleCoordinator["run"] = (threadId, operation) =>
    withThreadLock(
      threadId,
      Effect.suspend(() => {
        const generation = randomUUID();
        const previousGeneration = currentGenerations.get(threadId);
        currentGenerations.set(threadId, generation);
        let ownedGeneration = generation;
        const isCurrent = () => currentGenerations.get(threadId) === ownedGeneration;
        return operation({
          generation,
          isCurrent,
          adopt: (adoptedGeneration) => {
            if (isCurrent()) {
              ownedGeneration = adoptedGeneration;
              currentGenerations.set(threadId, adoptedGeneration);
            }
          },
          retire: () => {
            if (isCurrent()) currentGenerations.delete(threadId);
          },
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) && isCurrent()
              ? Effect.sync(() => {
                  if (previousGeneration === undefined) {
                    currentGenerations.delete(threadId);
                  } else {
                    currentGenerations.set(threadId, previousGeneration);
                  }
                })
              : Effect.void,
          ),
        );
      }),
    );

  return {
    run,
    runCurrent: (threadId, operation) =>
      withThreadLock(
        threadId,
        Effect.suspend(() => operation(currentGenerations.get(threadId))),
      ),
    adoptCurrent: (threadId, generation) => currentGenerations.set(threadId, generation),
    currentGeneration: (threadId) => currentGenerations.get(threadId),
  };
}
