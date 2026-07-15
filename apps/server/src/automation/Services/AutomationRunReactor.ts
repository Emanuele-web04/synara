import { Effect, Scope, ServiceMap } from "effect";

export interface AutomationRunReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class AutomationRunReactor extends ServiceMap.Service<
  AutomationRunReactor,
  AutomationRunReactorShape
>()("synara/automation/Services/AutomationRunReactor") {}
