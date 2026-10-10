import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface ProviderRuntimeIngestionShape {
  /**
   * Start ingesting provider runtime events into orchestration commands.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   *
   * Uses an internal queue and continues after non-interrupt failures by
   * logging warnings.
   * Complete tool progress snapshots share a bounded 50 ms wake window;
   * task phases/reasoning, text, approvals and terminals remain lossless and
   * flush the globally ordered preceding prefix immediately. Another thread's
   * text may shorten the wake window; this is not an independent priority lane.
   * Shutdown acknowledges completed rows without scanning unread journal work;
   * deferred durable progress replays on startup.
   */
  readonly start: Effect.Effect<void, never, Scope.Scope>;

  /** drops replay-ledger rows whose durable turn is already terminal — called after startup closes process-orphaned turns */
  readonly reconcileSettledOpenTurns: Effect.Effect<void>;

  /**
   * Resolves after the durable journal's captured high-water fence is processed
   * and acknowledged, including trailing progress, and the worker is idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

export class ProviderRuntimeIngestionService extends ServiceMap.Service<
  ProviderRuntimeIngestionService,
  ProviderRuntimeIngestionShape
>()("synara/orchestration/Services/ProviderRuntimeIngestion/ProviderRuntimeIngestionService") {}
