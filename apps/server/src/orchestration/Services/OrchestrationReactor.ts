import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface OrchestrationReactorShape {
  /** must run in a scope so worker fibers finalize on shutdown */
  readonly start: Effect.Effect<void, never, Scope.Scope>;

  /** reconciles durable provider replay state after restart turn recovery */
  readonly reconcileSettledOpenTurns: Effect.Effect<void>;
}

export class OrchestrationReactor extends ServiceMap.Service<
  OrchestrationReactor,
  OrchestrationReactorShape
>()("synara/orchestration/Services/OrchestrationReactor") {}
