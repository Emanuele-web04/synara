import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface ThreadSnoozeReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ThreadSnoozeReactor extends ServiceMap.Service<
  ThreadSnoozeReactor,
  ThreadSnoozeReactorShape
>()("synara/orchestration/Services/ThreadSnoozeReactor") {}
