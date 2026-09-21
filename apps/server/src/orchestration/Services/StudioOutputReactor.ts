/** pre-provider snapshots of the Studio workspace plus the worker diffing them at turn end — complements Git checkpoints which don't run in the non-Git Studio root */
import type { ThreadId } from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface StudioOutputReactorShape {
  /** ProviderCommandReactor awaits this before a turn starts so fast shell writes can't race into the baseline */
  readonly captureBaselineBeforeTurn: (threadId: ThreadId) => Effect.Effect<void>;

  /** drop a prepared baseline when dispatch fails before a turn starts */
  readonly cancelPendingTurnBaseline: (threadId: ThreadId) => Effect.Effect<void>;

  /** must run in a scope; turn.started associates the pre-dispatch baseline with the provider turn id, terminal events diff and persist it */
  readonly start: Effect.Effect<void, never, Scope.Scope>;

  /** resolves when the queue is empty and idle — for tests, replaces sleeps */
  readonly drain: Effect.Effect<void>;
}

export class StudioOutputReactor extends ServiceMap.Service<
  StudioOutputReactor,
  StudioOutputReactorShape
>()("synara/orchestration/Services/StudioOutputReactor") {}
