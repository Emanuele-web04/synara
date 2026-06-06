/**
 * Shared predicate for sourcing a thread's turn diff from its remote sandbox.
 *
 * A `remote-runtime` thread's agent edits the cloned repo inside the sandbox, so
 * the host CheckpointStore has nothing to diff. Both the live capture path
 * (CheckpointReactor) and the on-demand Review path (CheckpointDiffQuery) must
 * decide identically whether an instance is reachable for that diff — a diverging
 * gate would route one path to the sandbox while the other captured an empty host
 * checkpoint. This is the one place that decision lives.
 *
 * @module remoteDiffability
 */
import type {
  ExecutionInstanceId,
  ExecutionRuntimeProvider,
  OrchestrationThreadRuntime,
} from "@t3tools/contracts";

/** Instance statuses for which the sandbox is reachable for a workspace diff. */
export const REMOTE_DIFFABLE_INSTANCE_STATUSES: ReadonlySet<string> = new Set([
  "starting",
  "running",
  "idle",
]);

export interface DiffableRemoteInstance {
  readonly instanceId: ExecutionInstanceId;
  readonly provider: ExecutionRuntimeProvider;
  readonly rootPath: string | undefined;
}

/**
 * The instance to source a remote thread's turn diff from, or `null` to keep the
 * caller on the host CheckpointStore path: a local/worktree thread, a remote
 * thread with no provisioned instance, or one whose status is not reachable for a
 * diff.
 */
export const resolveDiffableRemoteInstance = (
  runtime: OrchestrationThreadRuntime | null | undefined,
): DiffableRemoteInstance | null => {
  if (runtime?.targetKind !== "remote-runtime") {
    return null;
  }
  const instance = runtime.instance;
  if (instance === null || !REMOTE_DIFFABLE_INSTANCE_STATUSES.has(instance.status)) {
    return null;
  }
  return {
    instanceId: instance.id,
    provider: instance.provider,
    rootPath: instance.rootPath ?? undefined,
  };
};
