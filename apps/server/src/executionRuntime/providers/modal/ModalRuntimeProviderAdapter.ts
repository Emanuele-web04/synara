/**
 * ModalRuntimeProviderAdapter - the Modal execution-runtime adapter.
 *
 * Pairs the per-role {@link modalDescriptorForRole} capability description with
 * the lifecycle operations that provision instances, run verification jobs, line-
 * frame a service's output, expose tunnels, and tear instances down. It routes
 * every command through {@link ModalCommandTransport}, so the same adapter works
 * whether a real Modal account or the local fake backs the transport.
 *
 * Modal is job/service-first: no PTY, logs are the process output stream, and
 * `Finished` is the terminal job state. The adapter reflects that honestly — it
 * never claims a PTY, and a non-zero exit from a job is a terminal result, not a
 * provider fault. Volume sync is the persistence story (`persistence.volumes`),
 * kept separate from snapshots, which Modal does not expose here.
 *
 * Like every adapter it never touches orchestration commands or persistence:
 * lifecycle recording is the `ExecutionRuntimeService`'s job. This keeps the
 * adapter a pure provider boundary.
 *
 * @module ModalRuntimeProviderAdapter
 */
import type {
  ExecutionInstanceId,
  RuntimeInstanceSummary,
  RuntimeRouteSummary,
} from "@t3tools/contracts";
import { RuntimeRouteId } from "@t3tools/contracts";
import { Effect, Layer, ServiceMap } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

import type {
  InMemoryTransportController,
  JsonRpcLineTransport,
} from "../../../provider/process/JsonRpcLineTransport.ts";
import type { RuntimeProviderDescriptor } from "../../Services/RuntimeProviderDescriptor.ts";
import {
  ModalCommandTransport,
  type ModalExecInput,
  type ModalExecResult,
  type ModalProcessSpawnInput,
} from "./ModalCommandTransport.ts";
import { modalDescriptorForRole } from "./modalDescriptors.ts";
import type { ModalRuntimeRole } from "./ModalRuntimeRole.ts";

export interface ModalProvisionInput {
  readonly threadId: string;
  readonly role: ModalRuntimeRole;
}

export interface ModalInstanceContextResult {
  readonly instance: RuntimeInstanceSummary;
  readonly rootPath: string;
  readonly role: ModalRuntimeRole;
}

export interface ModalRuntimeProviderAdapterShape {
  /** The descriptor for a Modal role, used by the planner before provisioning. */
  readonly descriptorForRole: (role: ModalRuntimeRole) => RuntimeProviderDescriptor;
  /** Whether a real Modal account backs this adapter (vs. the local fake). */
  readonly backendKind: "real" | "fake";
  /** Provision the instance backing a thread for a given Modal role. */
  readonly provision: (input: ModalProvisionInput) => Effect.Effect<ModalInstanceContextResult>;
  /**
   * Run a verification job: fire-and-collect a command, returning its full
   * stdout/stderr/exit. A non-zero exit is a terminal `Finished` job result, not
   * a provider failure.
   */
  readonly execCollect: (
    instanceId: ExecutionInstanceId,
    input: ModalExecInput,
  ) => Effect.Effect<ModalExecResult, never, ChildProcessSpawner.ChildProcessSpawner>;
  /**
   * Line-frame a long-lived service process's output into the in-memory
   * transport Codex consumes. When the spawn names no command a bare scriptable
   * transport is returned (a test drives its controller).
   */
  readonly createTransport: (
    instanceId: ExecutionInstanceId,
    spawn: ModalProcessSpawnInput,
  ) => Effect.Effect<
    { readonly transport: JsonRpcLineTransport; readonly controller: InMemoryTransportController },
    never,
    ChildProcessSpawner.ChildProcessSpawner
  >;
  /**
   * Expose a port as a tunnel / web endpoint, returning a route summary. Only
   * `service`/`preview` roles reach here — the planner rejects port requests a
   * `job` cannot honor before provisioning.
   */
  readonly exposePort: (
    instanceId: ExecutionInstanceId,
    port: number,
  ) => Effect.Effect<RuntimeRouteSummary>;
  /** Provider-agnostic liveness probe the reconciler reads. */
  readonly isAlive: (instanceId: ExecutionInstanceId) => Effect.Effect<boolean>;
  /** Tear the instance down. Idempotent. */
  readonly destroy: (instanceId: ExecutionInstanceId) => Effect.Effect<void>;
}

export class ModalRuntimeProviderAdapter extends ServiceMap.Service<
  ModalRuntimeProviderAdapter,
  ModalRuntimeProviderAdapterShape
>()("t3/executionRuntime/providers/modal/ModalRuntimeProviderAdapter") {}

const makeModalRuntimeProviderAdapter = Effect.gen(function* () {
  const transport = yield* ModalCommandTransport;

  const provision: ModalRuntimeProviderAdapterShape["provision"] = (input) =>
    Effect.gen(function* () {
      const context = yield* transport.provision({ threadId: input.threadId, role: input.role });
      const now = new Date().toISOString();
      const instance: RuntimeInstanceSummary = {
        id: context.instanceId,
        provider: "modal",
        status: "running",
        rootPath: context.rootPath,
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      };
      return { instance, rootPath: context.rootPath, role: context.role };
    });

  const exposePort: ModalRuntimeProviderAdapterShape["exposePort"] = (instanceId, port) =>
    transport.exposePort(instanceId, port).pipe(
      Effect.map((route) => {
        const now = new Date().toISOString();
        return {
          id: RuntimeRouteId.makeUnsafe(`modal-route-${instanceId}-${port}`),
          port,
          url: route.url,
          label: null,
          exposedAt: now,
        } satisfies RuntimeRouteSummary;
      }),
    );

  return {
    descriptorForRole: modalDescriptorForRole,
    backendKind: transport.backendKind,
    provision,
    execCollect: transport.execCollect,
    createTransport: transport.createTransport,
    exposePort,
    isAlive: transport.isAlive,
    destroy: transport.destroy,
  } satisfies ModalRuntimeProviderAdapterShape;
});

export const ModalRuntimeProviderAdapterLive = Layer.effect(
  ModalRuntimeProviderAdapter,
  makeModalRuntimeProviderAdapter,
);
