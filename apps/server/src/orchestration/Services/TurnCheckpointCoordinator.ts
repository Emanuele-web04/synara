/**
 * Serializes provider turn activation and checkpoint reverts for one thread.
 *
 * Revert admission and provider state checks cannot make a destructive restore
 * safe on their own: a provider turn may activate after the final check. Both
 * side-effect reactors therefore hold this shared lease while crossing their
 * respective mutation boundaries.
 */
import type { ThreadId } from "@synara/contracts";
import { ServiceMap, type Effect } from "effect";

export interface TurnCheckpointCoordinatorShape {
  readonly withThreadLease: <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class TurnCheckpointCoordinator extends ServiceMap.Service<
  TurnCheckpointCoordinator,
  TurnCheckpointCoordinatorShape
>()("synara/orchestration/Services/TurnCheckpointCoordinator") {}
