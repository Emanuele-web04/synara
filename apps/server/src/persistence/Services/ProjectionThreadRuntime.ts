/**
 * ProjectionThreadRuntimeRepository - persistence for execution-runtime state.
 *
 * Owns the dedicated `projection_thread_runtime` read-model row (one per thread,
 * hydrating `OrchestrationThread.runtime`) plus the operational
 * `execution_runtime_*` tables that back reconciliation. This is deliberately
 * separate from `projection_threads`: runtime state is optional, churns more
 * often than thread metadata, and is lifecycle-managed independently.
 */
import {
  ExecutionInstanceId,
  ExecutionRuntimeProvider,
  ExecutionTargetKind,
  IsoDateTime,
  OrchestrationThreadRuntime,
  RuntimeActivityLeaseId,
  RuntimeActivityLeaseSummary,
  RuntimeInstanceStatus,
  RuntimeProcessId,
  RuntimeProcessSummary,
  RuntimeRole,
  RuntimeRouteId,
  RuntimeRouteSummary,
  RuntimeSnapshotId,
  RuntimeSnapshotSummary,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

/** Denormalized read-model row that hydrates `OrchestrationThread.runtime`. */
export const ProjectionThreadRuntime = Schema.Struct({
  threadId: ThreadId,
  targetKind: ExecutionTargetKind,
  provider: ExecutionRuntimeProvider,
  role: RuntimeRole,
  runtimeInstanceId: Schema.NullOr(ExecutionInstanceId),
  status: RuntimeInstanceStatus,
  rootPath: Schema.NullOr(TrimmedNonEmptyString),
  instance: OrchestrationThreadRuntime.fields.instance,
  processes: Schema.Array(RuntimeProcessSummary),
  routes: Schema.Array(RuntimeRouteSummary),
  snapshots: Schema.Array(RuntimeSnapshotSummary),
  leases: Schema.Array(RuntimeActivityLeaseSummary),
  lastActivityAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type ProjectionThreadRuntime = typeof ProjectionThreadRuntime.Type;

/** Operational instance row, source for reconciliation. */
export const ExecutionRuntimeInstance = Schema.Struct({
  instanceId: ExecutionInstanceId,
  threadId: ThreadId,
  provider: ExecutionRuntimeProvider,
  status: RuntimeInstanceStatus,
  rootPath: Schema.NullOr(TrimmedNonEmptyString),
  failureReason: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ExecutionRuntimeInstance = typeof ExecutionRuntimeInstance.Type;

export const ExecutionRuntimeProcess = Schema.Struct({
  processId: RuntimeProcessId,
  instanceId: ExecutionInstanceId,
  threadId: ThreadId,
  role: RuntimeRole,
  command: Schema.NullOr(TrimmedNonEmptyString),
  status: Schema.Literals(["starting", "running", "exited", "failed"]),
  exitCode: Schema.NullOr(Schema.Int),
  failureReason: Schema.NullOr(TrimmedNonEmptyString),
  tail: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  exitedAt: Schema.NullOr(IsoDateTime),
});
export type ExecutionRuntimeProcess = typeof ExecutionRuntimeProcess.Type;

export const ExecutionRuntimeRoute = Schema.Struct({
  routeId: RuntimeRouteId,
  instanceId: ExecutionInstanceId,
  threadId: ThreadId,
  port: Schema.Int,
  url: Schema.NullOr(TrimmedNonEmptyString),
  label: Schema.NullOr(TrimmedNonEmptyString),
  exposedAt: IsoDateTime,
});
export type ExecutionRuntimeRoute = typeof ExecutionRuntimeRoute.Type;

export const ExecutionRuntimeSnapshot = Schema.Struct({
  snapshotId: RuntimeSnapshotId,
  instanceId: ExecutionInstanceId,
  threadId: ThreadId,
  label: Schema.NullOr(TrimmedNonEmptyString),
  secretTainted: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type ExecutionRuntimeSnapshot = typeof ExecutionRuntimeSnapshot.Type;

export const ExecutionRuntimeActivityLease = Schema.Struct({
  leaseId: RuntimeActivityLeaseId,
  instanceId: ExecutionInstanceId,
  threadId: ThreadId,
  reason: Schema.Literals(["turn", "terminal", "preview"]),
  acquiredAt: IsoDateTime,
  renewedAt: Schema.NullOr(IsoDateTime),
  expiresAt: Schema.NullOr(IsoDateTime),
  releasedAt: Schema.NullOr(IsoDateTime),
});
export type ExecutionRuntimeActivityLease = typeof ExecutionRuntimeActivityLease.Type;

export const ThreadIdInput = Schema.Struct({ threadId: ThreadId });
export type ThreadIdInput = typeof ThreadIdInput.Type;

export interface ProjectionThreadRuntimeRepositoryShape {
  /** Upsert the denormalized read-model row by `threadId`. */
  readonly upsertReadModel: (
    row: ProjectionThreadRuntime,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getReadModelByThreadId: (
    input: ThreadIdInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadRuntime>, ProjectionRepositoryError>;
  readonly listReadModels: () => Effect.Effect<
    ReadonlyArray<ProjectionThreadRuntime>,
    ProjectionRepositoryError
  >;
  readonly deleteByThreadId: (
    input: ThreadIdInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly upsertInstance: (
    row: ExecutionRuntimeInstance,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly upsertProcess: (
    row: ExecutionRuntimeProcess,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly upsertRoute: (
    row: ExecutionRuntimeRoute,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly upsertSnapshot: (
    row: ExecutionRuntimeSnapshot,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly upsertLease: (
    row: ExecutionRuntimeActivityLease,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadRuntimeRepository extends ServiceMap.Service<
  ProjectionThreadRuntimeRepository,
  ProjectionThreadRuntimeRepositoryShape
>()("t3/persistence/Services/ProjectionThreadRuntime/ProjectionThreadRuntimeRepository") {}
