import { Schema } from "effect";
import {
  ExecutionInstanceId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  RuntimeActivityLeaseId,
  RuntimeProcessId,
  RuntimeRouteId,
  RuntimeSnapshotId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { ProviderKind } from "./orchestration";

/**
 * Execution-runtime public read-model + plan-input contracts (schema-only).
 *
 * This is the third axis — *where* a thread's agent process runs — kept
 * strictly separate from `ProviderKind` (which agent) and `RuntimeMode`
 * (permission policy). The richer adapter/descriptor capability model stays
 * server-internal; only the types the read-model and create/handoff/fork
 * plan input need are public here. These do not extend `ProviderRuntimeEvent`:
 * runtime infra lifecycle is a separate event family.
 */

/** Where the agent process runs. `local`/`worktree` reproduce current behavior. */
export const ExecutionTargetKind = Schema.Literals(["local", "worktree", "remote-runtime"]);
export type ExecutionTargetKind = typeof ExecutionTargetKind.Type;

/** Which infrastructure backs a remote runtime instance. */
export const ExecutionRuntimeProvider = Schema.Literals([
  "local",
  "worktree",
  "daytona",
  "vercel-sandbox",
  "modal",
  "cloudflare",
]);
export type ExecutionRuntimeProvider = typeof ExecutionRuntimeProvider.Type;

/** Why a process runs inside an instance: the agent itself, setup, or git/exec utility work. */
export const RuntimeRole = Schema.Literals(["agent", "setup", "git", "exec", "terminal"]);
export type RuntimeRole = typeof RuntimeRole.Type;

/**
 * Provider-instance lifecycle (15 states). Covers provisioning, the running
 * window, idle/lease states, the terminal set, and the partial-failure /
 * reconciliation states remote providers introduce.
 */
export const RuntimeInstanceStatus = Schema.Literals([
  "pending",
  "provisioning",
  "starting",
  "running",
  "idle",
  "stopping",
  "stopped",
  "snapshotting",
  "archiving",
  "archived",
  "destroying",
  "destroyed",
  "failed",
  "lost",
  "unknown",
]);
export type RuntimeInstanceStatus = typeof RuntimeInstanceStatus.Type;

/** A process running inside a runtime instance. */
export const RuntimeProcessSummary = Schema.Struct({
  id: RuntimeProcessId,
  role: RuntimeRole,
  command: Schema.NullOr(TrimmedNonEmptyString),
  status: Schema.Literals(["starting", "running", "exited", "failed"]),
  exitCode: Schema.optional(Schema.NullOr(Schema.Int)).pipe(Schema.withDecodingDefault(() => null)),
  failureReason: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  startedAt: IsoDateTime,
  exitedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
});
export type RuntimeProcessSummary = typeof RuntimeProcessSummary.Type;

/** An exposed ingress/port route on a runtime instance (preview URLs, etc). */
export const RuntimeRouteSummary = Schema.Struct({
  id: RuntimeRouteId,
  port: PositiveInt,
  url: Schema.NullOr(TrimmedNonEmptyString),
  label: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  exposedAt: IsoDateTime,
});
export type RuntimeRouteSummary = typeof RuntimeRouteSummary.Type;

/** A persisted snapshot of a runtime instance. */
export const RuntimeSnapshotSummary = Schema.Struct({
  id: RuntimeSnapshotId,
  label: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  secretTainted: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  createdAt: IsoDateTime,
});
export type RuntimeSnapshotSummary = typeof RuntimeSnapshotSummary.Type;

/**
 * An activity lease keeping a remote instance alive while work is in flight
 * (active turn, terminal, or preview). Released on exit/close.
 */
export const RuntimeActivityLeaseSummary = Schema.Struct({
  id: RuntimeActivityLeaseId,
  reason: Schema.Literals(["turn", "terminal", "preview"]),
  acquiredAt: IsoDateTime,
  renewedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  expiresAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
});
export type RuntimeActivityLeaseSummary = typeof RuntimeActivityLeaseSummary.Type;

/** A runtime instance: the provider-backed infra a thread's processes run in. */
export const RuntimeInstanceSummary = Schema.Struct({
  id: ExecutionInstanceId,
  provider: ExecutionRuntimeProvider,
  status: RuntimeInstanceStatus,
  rootPath: Schema.NullOr(TrimmedNonEmptyString),
  failureReason: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type RuntimeInstanceSummary = typeof RuntimeInstanceSummary.Type;

/**
 * The runtime read-model hydrated onto `OrchestrationThread.runtime` (from the
 * dedicated `projection_thread_runtime` table, not the wide thread projection).
 */
export const OrchestrationThreadRuntime = Schema.Struct({
  threadId: ThreadId,
  targetKind: ExecutionTargetKind,
  provider: ExecutionRuntimeProvider,
  role: RuntimeRole,
  status: RuntimeInstanceStatus,
  instance: Schema.NullOr(RuntimeInstanceSummary),
  processes: Schema.Array(RuntimeProcessSummary).pipe(Schema.withDecodingDefault(() => [])),
  routes: Schema.Array(RuntimeRouteSummary).pipe(Schema.withDecodingDefault(() => [])),
  snapshots: Schema.Array(RuntimeSnapshotSummary).pipe(Schema.withDecodingDefault(() => [])),
  leases: Schema.Array(RuntimeActivityLeaseSummary).pipe(Schema.withDecodingDefault(() => [])),
  lastActivityAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  updatedAt: IsoDateTime,
});
export type OrchestrationThreadRuntime = typeof OrchestrationThreadRuntime.Type;

/**
 * Plan input for create/handoff/fork (exposed in a later slice). Describes the
 * requested execution target; the server-internal planner validates it against
 * the resolved provider descriptor before provisioning. No `runtimePlan` field
 * is wired onto any command yet — this is the input shape those commands will
 * carry.
 */
export const RuntimePlanResources = Schema.Struct({
  cpu: Schema.optional(PositiveInt),
  memoryMb: Schema.optional(PositiveInt),
  diskMb: Schema.optional(PositiveInt),
});
export type RuntimePlanResources = typeof RuntimePlanResources.Type;

export const RuntimePlan = Schema.Struct({
  targetKind: ExecutionTargetKind,
  provider: ExecutionRuntimeProvider,
  resources: Schema.optional(RuntimePlanResources),
  timeoutSeconds: Schema.optional(PositiveInt),
  ports: Schema.optional(Schema.Array(PositiveInt)).pipe(Schema.withDecodingDefault(() => [])),
  persistent: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  snapshotId: Schema.optional(Schema.NullOr(RuntimeSnapshotId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  maxRetries: Schema.optional(NonNegativeInt),
  providerKind: Schema.optional(ProviderKind),
});
export type RuntimePlan = typeof RuntimePlan.Type;
