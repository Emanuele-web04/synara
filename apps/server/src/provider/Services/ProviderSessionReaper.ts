import { Effect, Scope, ServiceMap } from "effect";

export interface ProviderSessionReaperShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ProviderSessionReaper extends ServiceMap.Service<
  ProviderSessionReaper,
  ProviderSessionReaperShape
>()("synara/provider/Services/ProviderSessionReaper") {}
