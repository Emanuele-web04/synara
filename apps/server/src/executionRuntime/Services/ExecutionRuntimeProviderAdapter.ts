/**
 * ExecutionRuntimeProviderAdapter - Server-internal contract a concrete
 * execution-runtime provider (local, worktree, fake-remote, Daytona, ...)
 * implements.
 *
 * Each adapter pairs a static {@link RuntimeProviderDescriptor} (what it can
 * do) with the lifecycle operations that provision and tear down instances and
 * create process transports. The orchestration seam never references a concrete
 * adapter; it goes through `ExecutionRuntimeService` (later slice) which routes
 * via the registry. Interface-only in this slice: no provider calls yet.
 *
 * @module ExecutionRuntimeProviderAdapter
 */
import type { Effect } from "effect";

import type {
  ExecutionInstanceId,
  RuntimeInstanceSummary,
  RuntimePlan,
  ThreadId,
} from "@t3tools/contracts";

import type { JsonRpcLineTransport } from "../../provider/process/JsonRpcLineTransport.ts";
import type { RuntimeProcessSpawnInput } from "./RuntimeProcessTransport.ts";
import type { RuntimeProviderDescriptor } from "./RuntimeProviderDescriptor.ts";

export interface RuntimeProvisionInput {
  readonly threadId: ThreadId;
  readonly plan: RuntimePlan;
}

export interface ExecutionRuntimeProviderAdapterShape {
  /** Static capability description used by the planner. */
  readonly descriptor: RuntimeProviderDescriptor;
  /** Provision (or resolve, for local/worktree) the instance backing a thread. */
  readonly provision: (input: RuntimeProvisionInput) => Effect.Effect<RuntimeInstanceSummary>;
  /** Create a JSON-RPC line transport for a process inside the instance. */
  readonly createTransport: (
    instanceId: ExecutionInstanceId,
    spawn: RuntimeProcessSpawnInput,
  ) => Effect.Effect<JsonRpcLineTransport>;
  /** Tear the instance down. Idempotent. */
  readonly destroy: (instanceId: ExecutionInstanceId) => Effect.Effect<void>;
}
