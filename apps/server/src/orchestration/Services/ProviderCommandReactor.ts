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
  /**
   * Start reacting to provider-intent orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   *
   * Filters orchestration domain events to provider-intent types before
   * processing. Delivery is FIFO per thread with bounded cross-thread
   * concurrency. The durable source cursor acknowledges only the settled
   * prefix; completed later deliveries remain journaled for restart recovery.
   */
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
