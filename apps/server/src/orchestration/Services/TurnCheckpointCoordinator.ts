/** serializes provider turn activation and checkpoint reverts per thread — a turn may activate after the final state check, so both reactors hold this lease across their mutation boundaries */
import type { ThreadId } from "@synara/contracts";
import { ServiceMap, type Effect } from "effect";

export interface TurnCheckpointCoordinatorShape {
  /** Physical Git checkout identity; preserves separate linked worktrees. */
  readonly resolveWorkspaceIdentity: (cwd: string) => Effect.Effect<string>;
  /** Acquire after a thread lease when both are needed; release after owned cleanup. */
  readonly withWorkspaceLease: <A, E, R>(
    cwd: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** Reuse an identity resolved with the physical Git checkout policy above; never invent one. */
  readonly withWorkspaceIdentityLease: <A, E, R>(
    identity: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly withThreadLease: <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class TurnCheckpointCoordinator extends ServiceMap.Service<
  TurnCheckpointCoordinator,
  TurnCheckpointCoordinatorShape
>()("synara/orchestration/Services/TurnCheckpointCoordinator") {}
