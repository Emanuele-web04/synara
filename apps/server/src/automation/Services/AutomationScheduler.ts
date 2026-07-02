import { Effect, Scope, ServiceMap } from "effect";

export interface AutomationSchedulerShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class AutomationScheduler extends ServiceMap.Service<
  AutomationScheduler,
  AutomationSchedulerShape
>()("t3/automation/Services/AutomationScheduler") {}
