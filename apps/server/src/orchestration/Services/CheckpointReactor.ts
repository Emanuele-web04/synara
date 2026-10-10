import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface CheckpointReactorShape {
  /** must run in a scope so worker fibers finalize on shutdown; consumes domain and provider-runtime events via an internal queue */
  readonly start: Effect.Effect<void, never, Scope.Scope>;

  /** resolves when the queue is empty and idle — for tests, replaces sleeps */
  readonly drain: Effect.Effect<void>;
}

export class CheckpointReactor extends ServiceMap.Service<
  CheckpointReactor,
  CheckpointReactorShape
>()("synara/orchestration/Services/CheckpointReactor") {}
