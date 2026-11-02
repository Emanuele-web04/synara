// FILE: UsageLimitRecoveryReactor.ts
// Purpose: Own the server-scoped scheduler for durable usage-limit continuations.
// Layer: Orchestration service contract

import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface UsageLimitRecoveryReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class UsageLimitRecoveryReactor extends ServiceMap.Service<
  UsageLimitRecoveryReactor,
  UsageLimitRecoveryReactorShape
>()("synara/orchestration/Services/UsageLimitRecoveryReactor") {}
