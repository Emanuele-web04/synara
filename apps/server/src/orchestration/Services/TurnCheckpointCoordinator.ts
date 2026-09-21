/** serializes provider turn activation and checkpoint reverts per thread — a turn may activate after the final state check, so both reactors hold this lease across their mutation boundaries */
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
