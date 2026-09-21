import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

import type { OrchestrationRegenerateThreadTitleResult, ThreadId } from "@synara/contracts";
import type {
  ProviderBlockingDeliveryEvidence,
  ProviderDeliveryReconciliationOutcome,
} from "../../persistence/Services/OrchestrationEventDeliveries.ts";

export interface ProviderDeliveryReconciliationResult {
  readonly eventSequence: number;
  readonly threadId: ThreadId;
  readonly outcome: ProviderDeliveryReconciliationOutcome;
  readonly state: "retry" | "succeeded" | "dead" | "uncertain";
  readonly reconciledAt: string;
}

export interface ProviderCommandReactorShape {
  /** must run in a scope so worker fibers finalize on shutdown; filters domain events to provider intents */
  readonly start: Effect.Effect<void, never, Scope.Scope>;

  /** resolves when the queue is empty and idle — for tests, replaces sleeps */
  readonly drain: Effect.Effect<void>;

  readonly listBlockingDeliveries: (input: {
    readonly threadId?: string | undefined;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ProviderBlockingDeliveryEvidence>, unknown>;

  readonly reconcileDelivery: (input: {
    readonly eventSequence: number;
    readonly threadId: ThreadId;
    readonly expectedState: "dead" | "uncertain";
    readonly outcome: ProviderDeliveryReconciliationOutcome;
    readonly reconciledBy: string;
    readonly note?: string | undefined;
  }) => Effect.Effect<ProviderDeliveryReconciliationResult | null, unknown>;

  readonly regenerateThreadTitle: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<OrchestrationRegenerateThreadTitleResult, unknown>;
}

export class ProviderCommandReactor extends ServiceMap.Service<
  ProviderCommandReactor,
  ProviderCommandReactorShape
>()("synara/orchestration/Services/ProviderCommandReactor") {}
