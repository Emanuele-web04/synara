/**
 * RuntimeWorkspaceDiff - Provider-agnostic working-tree diff for a remote
 * instance's cloned repo.
 *
 * A remote-runtime thread's agent edits the sandbox, not the host repo, so the
 * host CheckpointStore has nothing to diff. This seam runs `git` inside the
 * instance through the provider's exec channel (resolved by provider from
 * `RuntimeProviderRegistry`) and returns the unified working-tree diff plus the
 * path of every changed file. The caller supplies the instance's provider and
 * root from the persisted runtime row, so this service holds no per-instance
 * state — keeping it a thin, cycle-free dependency that both
 * `ExecutionRuntimeService` and `CheckpointDiffQuery` consume.
 *
 * Best-effort: a missing/destroyed instance, an exec failure, or a non-repo
 * workdir degrades to an empty-but-clean diff. It never throws.
 *
 * @module RuntimeWorkspaceDiff
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ExecutionInstanceId, ExecutionRuntimeProvider } from "@t3tools/contracts";

export interface RuntimeWorkspaceDiffInput {
  readonly instanceId: ExecutionInstanceId;
  readonly provider: ExecutionRuntimeProvider;
  /** The instance's working directory (its recorded `rootPath`). */
  readonly workdir: string | undefined;
}

export interface RuntimeWorkspaceDiffResult {
  readonly diff: string;
  readonly changedPaths: ReadonlyArray<string>;
}

export interface RuntimeWorkspaceDiffShape {
  readonly read: (input: RuntimeWorkspaceDiffInput) => Effect.Effect<RuntimeWorkspaceDiffResult>;
}

export class RuntimeWorkspaceDiff extends ServiceMap.Service<
  RuntimeWorkspaceDiff,
  RuntimeWorkspaceDiffShape
>()("t3/executionRuntime/Services/RuntimeWorkspaceDiff") {}
