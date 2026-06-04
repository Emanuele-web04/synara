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
  ExecutionTargetKind,
  RuntimeRole,
  ThreadId,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  InMemoryTransportController,
  JsonRpcLineTransport,
} from "../../provider/process/JsonRpcLineTransport.ts";
import type { RuntimeProvisionFailedError } from "../Errors.ts";
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

export interface ExecutionRuntimeProcessHandle {
  readonly processId: string;
  readonly transport: JsonRpcLineTransport;
  /**
   * The transport controller, exposed because the fake-remote transport is the
   * remote forwarding seam: a real remote adapter pushes remote stdout/stderr
   * into it and reads outbound frames back. Tests script it directly to drive a
   * provider protocol without a real binary.
   */
  readonly controller: InMemoryTransportController;
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
   * Resolve (and, for remote targets, provision) the execution target backing a
   * thread before its provider session starts. Idempotent: re-resolving a thread
   * that already has a live remote instance returns it without re-provisioning.
   */
  readonly ensureTargetForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ResolvedExecutionTarget, RuntimeProvisionFailedError>;
  /**
   * Start a process inside a provisioned instance and return its line transport,
   * recording process-start / -completed lifecycle through internal commands.
   */
  readonly exec: (
    input: ExecutionRuntimeExecInput,
  ) => Effect.Effect<ExecutionRuntimeProcessHandle, RuntimeProvisionFailedError>;
  /** Tear an instance down and record the destroyed event. Idempotent. */
  readonly destroy: (threadId: ThreadId, instanceId: ExecutionInstanceId) => Effect.Effect<void>;
}

export class ExecutionRuntimeService extends ServiceMap.Service<
  ExecutionRuntimeService,
  ExecutionRuntimeServiceShape
>()("t3/executionRuntime/Services/ExecutionRuntimeService") {}
