import { Effect, Scope, ServiceMap } from "effect";

export interface GoalContinuationReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class GoalContinuationReactor extends ServiceMap.Service<
  GoalContinuationReactor,
  GoalContinuationReactorShape
>()("t3/orchestration/Services/GoalContinuationReactor") {}
