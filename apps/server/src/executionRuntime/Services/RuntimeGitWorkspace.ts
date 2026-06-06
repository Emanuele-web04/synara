/**
 * RuntimeGitWorkspace - Server-internal, runtime-neutral git workspace boundary.
 *
 * Expresses git operations (`clone`, `checkout -B`, `status --porcelain`,
 * `diff --binary`) through a runtime's exec channel so the same calls work for
 * local, worktree, and remote instances. Local git RPCs are unchanged by this;
 * remote providers route these through their exec capability.
 *
 * @module RuntimeGitWorkspace
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

import type { ExecutionInstanceId } from "@t3tools/contracts";

import type { RuntimeGitFailedError } from "../Errors.ts";

export interface RuntimeGitCloneInput {
  readonly instanceId: ExecutionInstanceId;
  readonly repoUrl: string;
  readonly ref: string;
  readonly targetPath: string;
}

export interface RuntimeGitDiffInput {
  readonly instanceId: ExecutionInstanceId;
  readonly workdir: string;
}

export interface RuntimeGitStatusEntry {
  readonly path: string;
  readonly status: string;
}

export interface RuntimeGitWorkspaceShape {
  readonly clone: (
    input: RuntimeGitCloneInput,
  ) => Effect.Effect<void, RuntimeGitFailedError, ChildProcessSpawner.ChildProcessSpawner>;
  readonly status: (
    input: RuntimeGitDiffInput,
  ) => Effect.Effect<
    ReadonlyArray<RuntimeGitStatusEntry>,
    RuntimeGitFailedError,
    ChildProcessSpawner.ChildProcessSpawner
  >;
  readonly diff: (
    input: RuntimeGitDiffInput,
  ) => Effect.Effect<string, RuntimeGitFailedError, ChildProcessSpawner.ChildProcessSpawner>;
}

export class RuntimeGitWorkspace extends ServiceMap.Service<
  RuntimeGitWorkspace,
  RuntimeGitWorkspaceShape
>()("t3/executionRuntime/Services/RuntimeGitWorkspace") {}
