import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface WorktreeWorkspaceReactorShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
}

export class WorktreeWorkspaceReactor extends ServiceMap.Service<
  WorktreeWorkspaceReactor,
  WorktreeWorkspaceReactorShape
>()("synara/orchestration/Services/WorktreeWorkspaceReactor") {}
