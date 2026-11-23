import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface IdleCompactionReactorShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
}

export class IdleCompactionReactor extends ServiceMap.Service<
  IdleCompactionReactor,
  IdleCompactionReactorShape
>()("synara/orchestration/Services/IdleCompactionReactor") {}
