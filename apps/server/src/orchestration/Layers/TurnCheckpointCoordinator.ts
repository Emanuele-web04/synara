import type { ThreadId } from "@synara/contracts";
import { Effect, Layer, Semaphore } from "effect";

import {
  TurnCheckpointCoordinator,
  type TurnCheckpointCoordinatorShape,
} from "../Services/TurnCheckpointCoordinator.ts";

const make = Effect.sync(() => {
  const leases = new Map<ThreadId, { readonly semaphore: Semaphore.Semaphore; users: number }>();

  const withThreadLease: TurnCheckpointCoordinatorShape["withThreadLease"] = (threadId, effect) =>
    Effect.suspend(() => {
      let entry = leases.get(threadId);
      if (entry === undefined) {
        entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        leases.set(threadId, entry);
      }
      entry.users += 1;
      const acquiredEntry = entry;

      return acquiredEntry.semaphore
        .withPermits(1)(effect)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              acquiredEntry.users -= 1;
              if (acquiredEntry.users === 0 && leases.get(threadId) === acquiredEntry) {
                leases.delete(threadId);
              }
            }),
          ),
        );
    });

  return { withThreadLease } satisfies TurnCheckpointCoordinatorShape;
});

export const TurnCheckpointCoordinatorLive = Layer.effect(TurnCheckpointCoordinator, make);
