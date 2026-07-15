/**
 * StudioOutputReactor - Studio output capture service interface.
 *
 * Owns pre-provider snapshots of the Studio workspace tree and the background
 * worker that diffs them at turn end, attributing produced files to the thread.
 * Complements Git checkpoints, which intentionally do not run in the
 * (typically non-Git) Studio root.
 *
 * @module StudioOutputReactor
 */
import type { ThreadId } from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

/**
 * StudioOutputReactorShape - Service API for Studio output capture lifecycle.
 */
export interface StudioOutputReactorShape {
  /**
   * Capture a non-Git Studio workspace baseline before provider execution begins.
   * ProviderCommandReactor awaits this immediately before starting a new turn so
   * fast shell writes cannot race into the baseline.
   */
  readonly captureBaselineBeforeTurn: (threadId: ThreadId) => Effect.Effect<void>;

  /**
   * Drop a prepared baseline when provider dispatch fails before a turn starts.
   */
  readonly cancelPendingTurnBaseline: (threadId: ThreadId) => Effect.Effect<void>;

  /**
   * Start the Studio output reactor.
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
 * StudioOutputReactor - Service tag for the Studio output capture worker.
 */
export class StudioOutputReactor extends ServiceMap.Service<
  StudioOutputReactor,
  StudioOutputReactorShape
>()("synara/orchestration/Services/StudioOutputReactor") {}
