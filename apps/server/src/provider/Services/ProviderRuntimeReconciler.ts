import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface ProviderRuntimeReconcilerShape {
  readonly reconcileNow: Effect.Effect<void, unknown>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ProviderRuntimeReconciler extends ServiceMap.Service<
  ProviderRuntimeReconciler,
  ProviderRuntimeReconcilerShape
>()("synara/provider/Services/ProviderRuntimeReconciler") {}
