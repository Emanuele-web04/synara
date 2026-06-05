/**
 * ExecutionRuntimeService - The orchestration-facing seam for *where* a thread's
 * agent process runs.
 *
 * The provider command reactor calls only this service (plus `ProviderService`):
 * it never references a concrete runtime provider's ids, states, or routes. For
 * `local`/`worktree` threads this resolves the existing workspace cwd and does
 * no provisioning, preserving current behavior exactly. For `remote-runtime`
 * threads it routes to the resolved adapter, provisions an instance, and records
 * the resolved facts through internal orchestration commands so runtime state is
 * event-sourced and survives reconnect.
 *
 * `exec` starts a process inside an instance and returns its line transport
 * (the same `JsonRpcLineTransport` Codex consumes), recording process lifecycle
 * events. `destroy` tears the instance down idempotently.
 *
 * @module ExecutionRuntimeService
 */
import type {
  ExecutionInstanceId,
  ExecutionRuntimeProvider,
  ExecutionTargetKind,
  OrchestrationThreadRuntime,
  RuntimeInstanceStatus,
  RuntimePlan,
  RuntimeRole,
  ThreadId,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  InMemoryTransportController,
  JsonRpcLineTransport,
} from "../../provider/process/JsonRpcLineTransport.ts";
import type {
  MissingCredentialsError,
  RuntimePlanRejectedError,
  RuntimeProvisionFailedError,
  RuntimeProviderUnsupportedError,
} from "../Errors.ts";
import type { FakeRuntimeFlavor } from "./FakeRuntimeFlavor.ts";

/**
 * The resolved execution target for a thread. `cwd` is the working directory the
 * provider session should run in (project root, worktree path, or a provisioned
 * remote root). `instanceId` is present only for provisioned remote runtimes;
 * `local`/`worktree` targets carry none, signalling the reactor to use its
 * existing local spawn path unchanged.
 */
export interface ResolvedExecutionTarget {
  readonly threadId: ThreadId;
  readonly targetKind: ExecutionTargetKind;
  readonly cwd: string | undefined;
  readonly instanceId: ExecutionInstanceId | null;
}

export interface ExecutionRuntimeExecInput {
  readonly threadId: ThreadId;
  readonly instanceId: ExecutionInstanceId;
  readonly role: RuntimeRole;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Record<string, string | undefined>;
}

/**
 * Provider-agnostic liveness verdict for a persisted instance, the only fact the
 * reconciler reads back from a provider. `supportsReconnect` mirrors the resolved
 * descriptor's `lifecycle.reconnect` flag so the reconciler decides what to do
 * without ever naming a provider:
 *
 * - `supportsReconnect: false` — the provider cannot re-attach after a restart,
 *   so a persisted instance is unrecoverable and must be marked `lost`.
 * - `supportsReconnect: true` + `liveness: "alive"` — re-attach succeeded.
 * - `supportsReconnect: true` + `liveness: "absent"` — DB row exists but the
 *   provider has no record of the instance; mark `lost`.
 *
 * `liveActivity` is true while the service holds a live transport (and its
 * activity lease) for the instance this process lifetime — an in-flight turn.
 * The reconciler reads it to skip idle-destroy under a live agent, since
 * stream-only output is not event-sourced so `lastActivityAt` would otherwise
 * freeze mid-conversation and trip the idle threshold. It does not exempt the TTL
 * cap (a hard age limit) or the lost/absent verdicts.
 */
export interface RuntimeInstanceProbe {
  readonly supportsReconnect: boolean;
  readonly liveness: "alive" | "absent";
  readonly liveActivity: boolean;
}

export interface ExecutionRuntimeProcessHandle {
  readonly processId: string;
  readonly transport: JsonRpcLineTransport;
  /**
   * The transport controller, exposed because the fake-remote transport is the
   * remote forwarding seam: a real remote adapter pushes remote stdout/stderr
   * into it and reads outbound frames back. Tests script it directly to drive a
   * provider protocol without a real binary. Optional because a provider whose
   * transport is already wired to a live stdio (no in-memory forwarding seam)
   * returns no controller.
   */
  readonly controller?: InMemoryTransportController;
}

export interface ExecutionRuntimeServiceShape {
  /**
   * Internal entry point that marks a thread as backed by a fake-remote runtime
   * flavor and records the provision request as an orchestration event. This is
   * the internal command path that stands in for a public `runtimePlan` until a
   * later slice exposes one. `ensureTargetForThread` then provisions using the
   * registered flavor.
   */
  readonly markThreadRemote: (input: {
    readonly threadId: ThreadId;
    readonly flavor: FakeRuntimeFlavor;
    readonly role?: RuntimeRole;
  }) => Effect.Effect<void, RuntimeProvisionFailedError>;
  /**
   * Public entry point that honors a `RuntimePlan` carried on
   * create/handoff/fork. For `local`/`worktree` (or no plan) it does nothing,
   * preserving the existing compat path. For `remote-runtime` it validates the
   * plan against the resolved descriptor *before* any provisioning, rejects a
   * non-`fake` provider with no credentials configured, then marks the thread
   * remote with the flavor derived from the plan. Validation failures surface as
   * `RuntimePlanRejectedError` / `RuntimeProviderUnsupportedError`; a missing-creds
   * provider surfaces as `MissingCredentialsError`, so both are rejected
   * pre-provision.
   */
  readonly applyRuntimePlan: (input: {
    readonly threadId: ThreadId;
    readonly plan: RuntimePlan | null | undefined;
    readonly role?: RuntimeRole;
  }) => Effect.Effect<
    void,
    | RuntimeProvisionFailedError
    | RuntimePlanRejectedError
    | RuntimeProviderUnsupportedError
    | MissingCredentialsError
  >;
  /**
   * Resolve (and, for remote targets, provision) the execution target backing a
   * thread before its provider session starts. Idempotent: re-resolving a thread
   * that already has a live remote instance returns it without re-provisioning.
   *
   * `runtime` is the already-hydrated `OrchestrationThread.runtime` row when the
   * caller holds it (the reactor loaded the full thread detail before this call).
   * Passing it skips a redundant full thread-detail query on the turn-start hot
   * path; omit it (or pass `undefined`) to have the service load it itself.
   */
  readonly ensureTargetForThread: (
    threadId: ThreadId,
    runtime?: OrchestrationThreadRuntime | null,
  ) => Effect.Effect<ResolvedExecutionTarget, RuntimeProvisionFailedError>;
  /**
   * Start a process inside a provisioned instance and return its line transport,
   * recording process-start / -completed lifecycle through internal commands.
   */
  readonly exec: (
    input: ExecutionRuntimeExecInput,
  ) => Effect.Effect<ExecutionRuntimeProcessHandle, RuntimeProvisionFailedError>;
  /**
   * Tear an instance down and record the destroyed event. Idempotent.
   *
   * `provider` is the provider backing the instance when the caller already knows
   * it (the reconciler reads it off the DB row). The in-memory instance→provider
   * map is empty after a server restart — precisely when the reconciler runs its
   * TTL/idle destroy and pending-destroy retry — so without this fallback the
   * adapter teardown is skipped while the event log still records the instance as
   * destroyed, leaking the remote sandbox. Passing it resolves the adapter from
   * the DB even on a cold map.
   */
  readonly destroy: (
    threadId: ThreadId,
    instanceId: ExecutionInstanceId,
    provider?: ExecutionRuntimeProvider,
  ) => Effect.Effect<void>;
  /**
   * Stop a running instance without destroying it, recording the resulting state.
   * Resolves the adapter for the instance's recorded provider (the `destroy`
   * fallback to a caller-supplied provider applies here too, for a cold map after
   * restart). When the resolved adapter does not support stop, the operation is a
   * no-op beyond recording the requested state transition; it never throws.
   */
  readonly stop: (
    threadId: ThreadId,
    instanceId: ExecutionInstanceId,
    provider?: ExecutionRuntimeProvider,
  ) => Effect.Effect<void>;
  /**
   * Snapshot an instance for later resume, recording the created snapshot. Resolves
   * the adapter for the instance's recorded provider (same cold-map fallback as
   * `destroy`). When the resolved adapter does not support snapshots, the operation
   * is a graceful no-op; it never throws.
   */
  readonly snapshot: (
    threadId: ThreadId,
    instanceId: ExecutionInstanceId,
    provider?: ExecutionRuntimeProvider,
  ) => Effect.Effect<void>;
  /**
   * Probe a persisted instance against its provider for reconciliation. Resolves
   * the provider's reconnect capability and (when supported) whether the instance
   * is still recognized. Provider-specifics stay here; the reconciler reads only
   * the {@link RuntimeInstanceProbe} verdict, keeping it provider-agnostic.
   */
  readonly probeInstance: (input: {
    readonly provider: ExecutionRuntimeProvider;
    readonly instanceId: ExecutionInstanceId;
  }) => Effect.Effect<RuntimeInstanceProbe>;
  /**
   * Record a runtime instance state transition (e.g. `lost`/`failed`) as an
   * orchestration event so the read-model and operational tables converge. Uses a
   * stable per-instance/per-status commandId so a reconnect/crash retry dedupes on
   * the receipt rather than re-appending.
   */
  readonly recordInstanceState: (input: {
    readonly threadId: ThreadId;
    readonly instanceId: ExecutionInstanceId;
    readonly status: RuntimeInstanceStatus;
    readonly failureReason?: string | null;
  }) => Effect.Effect<void, RuntimeProvisionFailedError>;
}

export class ExecutionRuntimeService extends ServiceMap.Service<
  ExecutionRuntimeService,
  ExecutionRuntimeServiceShape
>()("t3/executionRuntime/Services/ExecutionRuntimeService") {}
