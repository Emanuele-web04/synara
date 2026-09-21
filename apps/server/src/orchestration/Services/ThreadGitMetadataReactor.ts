import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface ThreadGitMetadataReactorShape {
  /** starts the provider-turn observer persisting branch and PR metadata */
  readonly start: Effect.Effect<void, never, Scope.Scope>;

  /** resolves when every captured turn boundary has been reconciled */
  readonly drain: Effect.Effect<void>;
}

export class ThreadGitMetadataReactor extends ServiceMap.Service<
  ThreadGitMetadataReactor,
  ThreadGitMetadataReactorShape
>()("synara/orchestration/Services/ThreadGitMetadataReactor") {}
