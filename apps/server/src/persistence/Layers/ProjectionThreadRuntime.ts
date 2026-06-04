import {
  RuntimeActivityLeaseSummary,
  RuntimeInstanceSummary,
  RuntimeProcessSummary,
  RuntimeRouteSummary,
  RuntimeSnapshotSummary,
} from "@t3tools/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ExecutionRuntimeActivityLease,
  ExecutionRuntimeInstance,
  ExecutionRuntimeProcess,
  ExecutionRuntimeRoute,
  ExecutionRuntimeSnapshot,
  ProjectionThreadRuntime,
  ProjectionThreadRuntimeRepository,
  ThreadIdInput,
  type ProjectionThreadRuntimeRepositoryShape,
} from "../Services/ProjectionThreadRuntime.ts";

// The denormalized read-model row stores its array/instance summaries as JSON
// text and `secret_tainted`-style flags inline in the summaries themselves.
const ProjectionThreadRuntimeDbRow = ProjectionThreadRuntime.mapFields(
  Struct.assign({
    instance: Schema.NullOr(Schema.fromJsonString(RuntimeInstanceSummary)),
    processes: Schema.fromJsonString(Schema.Array(RuntimeProcessSummary)),
    routes: Schema.fromJsonString(Schema.Array(RuntimeRouteSummary)),
    snapshots: Schema.fromJsonString(Schema.Array(RuntimeSnapshotSummary)),
    leases: Schema.fromJsonString(Schema.Array(RuntimeActivityLeaseSummary)),
  }),
);

const makeProjectionThreadRuntimeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertReadModelRow = SqlSchema.void({
    Request: ProjectionThreadRuntimeDbRow,
    execute: (row) => sql`
      INSERT INTO projection_thread_runtime (
        thread_id,
        target_kind,
        provider,
        role,
        runtime_instance_id,
        status,
        root_path,
        instance_json,
        processes_json,
        routes_json,
        snapshots_json,
        leases_json,
        last_activity_at,
        updated_at
      )
      VALUES (
        ${row.threadId},
        ${row.targetKind},
        ${row.provider},
        ${row.role},
        ${row.runtimeInstanceId},
        ${row.status},
        ${row.rootPath},
        ${row.instance},
        ${row.processes},
        ${row.routes},
        ${row.snapshots},
        ${row.leases},
        ${row.lastActivityAt},
        ${row.updatedAt}
      )
      ON CONFLICT (thread_id)
      DO UPDATE SET
        target_kind = excluded.target_kind,
        provider = excluded.provider,
        role = excluded.role,
        runtime_instance_id = excluded.runtime_instance_id,
        status = excluded.status,
        root_path = excluded.root_path,
        instance_json = excluded.instance_json,
        processes_json = excluded.processes_json,
        routes_json = excluded.routes_json,
        snapshots_json = excluded.snapshots_json,
        leases_json = excluded.leases_json,
        last_activity_at = excluded.last_activity_at,
        updated_at = excluded.updated_at
    `,
  });

  const getReadModelRow = SqlSchema.findOneOption({
    Request: ThreadIdInput,
    Result: ProjectionThreadRuntimeDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        target_kind AS "targetKind",
        provider,
        role,
        runtime_instance_id AS "runtimeInstanceId",
        status,
        root_path AS "rootPath",
        instance_json AS "instance",
        processes_json AS "processes",
        routes_json AS "routes",
        snapshots_json AS "snapshots",
        leases_json AS "leases",
        last_activity_at AS "lastActivityAt",
        updated_at AS "updatedAt"
      FROM projection_thread_runtime
      WHERE thread_id = ${threadId}
    `,
  });

  const listReadModelRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadRuntimeDbRow,
    execute: () => sql`
      SELECT
        thread_id AS "threadId",
        target_kind AS "targetKind",
        provider,
        role,
        runtime_instance_id AS "runtimeInstanceId",
        status,
        root_path AS "rootPath",
        instance_json AS "instance",
        processes_json AS "processes",
        routes_json AS "routes",
        snapshots_json AS "snapshots",
        leases_json AS "leases",
        last_activity_at AS "lastActivityAt",
        updated_at AS "updatedAt"
      FROM projection_thread_runtime
      ORDER BY thread_id ASC
    `,
  });

  const deleteReadModelRow = SqlSchema.void({
    Request: ThreadIdInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_runtime WHERE thread_id = ${threadId}
    `,
  });

  const upsertInstanceRow = SqlSchema.void({
    Request: ExecutionRuntimeInstance,
    execute: (row) => sql`
      INSERT INTO execution_runtime_instances (
        instance_id, thread_id, provider, status, root_path, failure_reason, created_at, updated_at
      )
      VALUES (
        ${row.instanceId}, ${row.threadId}, ${row.provider}, ${row.status}, ${row.rootPath},
        ${row.failureReason}, ${row.createdAt}, ${row.updatedAt}
      )
      ON CONFLICT (instance_id)
      DO UPDATE SET
        thread_id = excluded.thread_id,
        provider = excluded.provider,
        status = excluded.status,
        root_path = excluded.root_path,
        failure_reason = excluded.failure_reason,
        updated_at = excluded.updated_at
    `,
  });

  const upsertProcessRow = SqlSchema.void({
    Request: ExecutionRuntimeProcess,
    execute: (row) => sql`
      INSERT INTO execution_runtime_processes (
        process_id, instance_id, thread_id, role, command, status, exit_code, failure_reason, tail,
        started_at, exited_at
      )
      VALUES (
        ${row.processId}, ${row.instanceId}, ${row.threadId}, ${row.role}, ${row.command},
        ${row.status}, ${row.exitCode}, ${row.failureReason}, ${row.tail}, ${row.startedAt},
        ${row.exitedAt}
      )
      ON CONFLICT (process_id)
      DO UPDATE SET
        instance_id = excluded.instance_id,
        thread_id = excluded.thread_id,
        role = excluded.role,
        command = excluded.command,
        status = excluded.status,
        exit_code = excluded.exit_code,
        failure_reason = excluded.failure_reason,
        tail = excluded.tail,
        started_at = excluded.started_at,
        exited_at = excluded.exited_at
    `,
  });

  const upsertRouteRow = SqlSchema.void({
    Request: ExecutionRuntimeRoute,
    execute: (row) => sql`
      INSERT INTO execution_runtime_routes (
        route_id, instance_id, thread_id, port, url, label, exposed_at
      )
      VALUES (
        ${row.routeId}, ${row.instanceId}, ${row.threadId}, ${row.port}, ${row.url}, ${row.label},
        ${row.exposedAt}
      )
      ON CONFLICT (route_id)
      DO UPDATE SET
        instance_id = excluded.instance_id,
        thread_id = excluded.thread_id,
        port = excluded.port,
        url = excluded.url,
        label = excluded.label,
        exposed_at = excluded.exposed_at
    `,
  });

  const upsertSnapshotRow = SqlSchema.void({
    Request: ExecutionRuntimeSnapshot,
    execute: (row) => sql`
      INSERT INTO execution_runtime_snapshots (
        snapshot_id, instance_id, thread_id, label, secret_tainted, created_at
      )
      VALUES (
        ${row.snapshotId}, ${row.instanceId}, ${row.threadId}, ${row.label},
        ${row.secretTainted ? 1 : 0}, ${row.createdAt}
      )
      ON CONFLICT (snapshot_id)
      DO UPDATE SET
        instance_id = excluded.instance_id,
        thread_id = excluded.thread_id,
        label = excluded.label,
        secret_tainted = excluded.secret_tainted,
        created_at = excluded.created_at
    `,
  });

  const upsertLeaseRow = SqlSchema.void({
    Request: ExecutionRuntimeActivityLease,
    execute: (row) => sql`
      INSERT INTO execution_runtime_activity_leases (
        lease_id, instance_id, thread_id, reason, acquired_at, renewed_at, expires_at, released_at
      )
      VALUES (
        ${row.leaseId}, ${row.instanceId}, ${row.threadId}, ${row.reason}, ${row.acquiredAt},
        ${row.renewedAt}, ${row.expiresAt}, ${row.releasedAt}
      )
      ON CONFLICT (lease_id)
      DO UPDATE SET
        instance_id = excluded.instance_id,
        thread_id = excluded.thread_id,
        reason = excluded.reason,
        acquired_at = excluded.acquired_at,
        renewed_at = excluded.renewed_at,
        expires_at = excluded.expires_at,
        released_at = excluded.released_at
    `,
  });

  const upsertReadModel: ProjectionThreadRuntimeRepositoryShape["upsertReadModel"] = (row) =>
    upsertReadModelRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRuntimeRepository.upsertReadModel")),
    );

  const getReadModelByThreadId: ProjectionThreadRuntimeRepositoryShape["getReadModelByThreadId"] = (
    input,
  ) =>
    getReadModelRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadRuntimeRepository.getReadModelByThreadId"),
      ),
    );

  const listReadModels: ProjectionThreadRuntimeRepositoryShape["listReadModels"] = () =>
    listReadModelRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRuntimeRepository.listReadModels")),
    );

  const deleteByThreadId: ProjectionThreadRuntimeRepositoryShape["deleteByThreadId"] = (input) =>
    deleteReadModelRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRuntimeRepository.deleteByThreadId")),
    );

  const upsertInstance: ProjectionThreadRuntimeRepositoryShape["upsertInstance"] = (row) =>
    upsertInstanceRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRuntimeRepository.upsertInstance")),
    );

  const upsertProcess: ProjectionThreadRuntimeRepositoryShape["upsertProcess"] = (row) =>
    upsertProcessRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRuntimeRepository.upsertProcess")),
    );

  const upsertRoute: ProjectionThreadRuntimeRepositoryShape["upsertRoute"] = (row) =>
    upsertRouteRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRuntimeRepository.upsertRoute")),
    );

  const upsertSnapshot: ProjectionThreadRuntimeRepositoryShape["upsertSnapshot"] = (row) =>
    upsertSnapshotRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRuntimeRepository.upsertSnapshot")),
    );

  const upsertLease: ProjectionThreadRuntimeRepositoryShape["upsertLease"] = (row) =>
    upsertLeaseRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRuntimeRepository.upsertLease")),
    );

  return {
    upsertReadModel,
    getReadModelByThreadId,
    listReadModels,
    deleteByThreadId,
    upsertInstance,
    upsertProcess,
    upsertRoute,
    upsertSnapshot,
    upsertLease,
  } satisfies ProjectionThreadRuntimeRepositoryShape;
});

export const ProjectionThreadRuntimeRepositoryLive = Layer.effect(
  ProjectionThreadRuntimeRepository,
  makeProjectionThreadRuntimeRepository,
);
