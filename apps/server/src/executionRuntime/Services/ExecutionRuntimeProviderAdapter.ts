/**
 * ExecutionRuntimeProviderAdapter - the provider-agnostic adapter surface
 * `ExecutionRuntimeService` consumes to provision instances, run processes, and
 * tear instances down.
 *
 * Every concrete execution-runtime provider (fake-remote today; Daytona, Vercel,
 * Modal, Cloudflare in later increments) conforms to this shape, so the service
 * routes by provider through `RuntimeProviderRegistry.getAdapter` without ever
 * naming a concrete provider. The Effect error and requirement channels match the
 * fake adapter exactly so the fake conforms through a thin facade rather than a
 * lossy down-cast. Provider→descriptor resolution stays the registry's job; this
 * surface is lifecycle-only.
 *
 * @module ExecutionRuntimeProviderAdapter
 */
import type { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

import type {
  ExecutionInstanceId,
  RuntimeInstanceSummary,
  RuntimePlan,
  ThreadId,
} from "@t3tools/contracts";

import type {
  InMemoryTransportController,
  JsonRpcLineTransport,
} from "../../provider/process/JsonRpcLineTransport.ts";
import type { RuntimeInstanceUnknownError, RuntimeRemoteOperationFailedError } from "../Errors.ts";
import type { RuntimeProcessSpawnInput } from "./RuntimeProcessTransport.ts";

/** Input for provisioning the instance backing a thread from its resolved plan. */
export interface ExecutionRuntimeProvisionInput {
  readonly threadId: ThreadId;
  readonly plan: RuntimePlan;
}

/** Result of provisioning: the recorded instance plus its working-directory root. */
export interface ExecutionRuntimeProvisionResult {
  readonly instance: RuntimeInstanceSummary;
  readonly rootPath: string;
}

/** A collected fire-and-collect command run inside an instance. */
export interface ExecutionRuntimeExecCollectInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Resolved relative to the instance root; defaults to the root. */
  readonly cwd?: string | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
}

export interface ExecutionRuntimeExecCollectResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

/**
 * The lifecycle surface a concrete runtime provider exposes. Signatures mirror
 * the fake adapter (requirement channels included) so any provider plugs in
 * without the service learning provider-specific error shapes. `provision` and
 * `createTransport` carry the provider-neutral `RuntimeRemoteOperationFailedError`
 * so a real provider outage at provision time (auth/quota/5xx/network) reaches
 * the service as a recoverable typed failure it maps to
 * `RuntimeProvisionFailedError`, rather than a fiber defect. Providers that
 * cannot fail at these steps (fake, Modal) conform with a `never` channel.
 */
export interface ExecutionRuntimeProviderAdapterShape {
  /** Provision the instance backing a thread, deriving any provider-internal sub-kind from the plan. */
  readonly provision: (
    input: ExecutionRuntimeProvisionInput,
  ) => Effect.Effect<ExecutionRuntimeProvisionResult, RuntimeRemoteOperationFailedError>;
  /**
   * Create the line transport for a process inside the instance. When the spawn
   * input names a runnable command, the provider forwards it into the transport
   * queues; otherwise it returns a bare scriptable transport the caller drives.
   */
  readonly createTransport: (
    instanceId: ExecutionInstanceId,
    spawn: RuntimeProcessSpawnInput,
  ) => Effect.Effect<
    { readonly transport: JsonRpcLineTransport; readonly controller?: InMemoryTransportController },
    RuntimeRemoteOperationFailedError,
    ChildProcessSpawner.ChildProcessSpawner
  >;
  /** Fire-and-collect command exec inside an instance, collecting full output. */
  readonly execCollect: (
    instanceId: ExecutionInstanceId,
    input: ExecutionRuntimeExecCollectInput,
  ) => Effect.Effect<
    ExecutionRuntimeExecCollectResult,
    RuntimeInstanceUnknownError,
    ChildProcessSpawner.ChildProcessSpawner
  >;
  /** Whether the provider still recognizes a provisioned instance (reconnect probe). */
  readonly isAlive: (instanceId: ExecutionInstanceId) => Effect.Effect<boolean>;
  /** Tear the instance down and forget it. Idempotent. */
  readonly destroy: (instanceId: ExecutionInstanceId) => Effect.Effect<void>;
  /**
   * Stop the instance without destroying it (filesystem persists), when the
   * provider supports a stop/suspend operation. Optional: a provider that cannot
   * stop an instance leaves this undefined, and the service treats undefined as
   * unsupported (no-op).
   */
  readonly stop?: (instanceId: ExecutionInstanceId) => Effect.Effect<void>;
  /**
   * Snapshot the instance for later resume, returning the snapshot id when the
   * provider supports snapshots. Optional: a provider with no snapshot capability
   * leaves this undefined, and the service treats undefined as unsupported (no-op).
   */
  readonly snapshot?: (
    instanceId: ExecutionInstanceId,
    label: string | null,
  ) => Effect.Effect<string | null>;
}
