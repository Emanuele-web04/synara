import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface ProviderRuntimeIngestionShape {
  /** must run in a scope so worker fibers finalize on shutdown; continues after non-interrupt failures by logging warnings */
  readonly start: Effect.Effect<void, never, Scope.Scope>;

  /** drops replay-ledger rows whose durable turn is already terminal — called after startup closes process-orphaned turns */
  readonly reconcileSettledOpenTurns: Effect.Effect<void>;

  /** resolves when the queue is empty and idle — for tests, replaces sleeps */
  readonly drain: Effect.Effect<void>;
}

export class ProviderRuntimeIngestionService extends ServiceMap.Service<
  ProviderRuntimeIngestionService,
  ProviderRuntimeIngestionShape
>()("synara/orchestration/Services/ProviderRuntimeIngestion/ProviderRuntimeIngestionService") {}
