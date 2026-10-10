/**
 * HubOutputReactor - Hub output capture service interface.
 *
 * Owns pre-provider snapshots of the Hub workspace tree and the background
 * worker that diffs them at turn end, attributing produced files to the thread.
 * Complements Git checkpoints, which intentionally do not run in the
 * (typically non-Git) Hub root.
 *
 * @module HubOutputReactor
 */
import type { ThreadId } from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export type HubBaselinePreparation =
  | { readonly status: "completed" | "not-applicable" }
  | { readonly status: "failed"; readonly detail: string };

/**
 * HubOutputReactorShape - Service API for Hub output capture lifecycle.
 */
export interface HubOutputReactorShape {
  /**
   * Capture a non-Git Hub workspace baseline before provider execution begins.
   * ProviderCommandReactor awaits this immediately before starting a new turn so
   * fast shell writes cannot race into the baseline. Returns whether a baseline
   * was prepared, no Hub workspace applies, or preparation failed. Cancellation
   * still propagates so provider dispatch waits for preparation cleanup.
   */
  readonly captureBaselineBeforeTurn: (threadId: ThreadId) => Effect.Effect<HubBaselinePreparation>;

  /**
   * Drop a prepared baseline when provider dispatch fails before a turn starts.
   */
  readonly cancelPendingTurnBaseline: (threadId: ThreadId) => Effect.Effect<void>;

  /**
   * Start the Hub output reactor.
   *
   * The returned effect must be run in a scope so the worker fiber can be
   * finalized on shutdown.
   *
   * Consumes provider-runtime turn lifecycle events via an internal queue. A
   * `turn.started` event associates the already captured pre-dispatch baseline
   * with the provider turn id; terminal events diff and persist it.
   */
  readonly start: Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * HubOutputReactor - Service tag for the Hub output capture worker.
 */
export class HubOutputReactor extends ServiceMap.Service<HubOutputReactor, HubOutputReactorShape>()(
  "synara/orchestration/Services/HubOutputReactor",
) {}
