import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Read-model row per thread. Hydrates `OrchestrationThread.runtime` via a
  // dedicated query, keeping runtime churn off the wide/hot `projection_threads`
  // table. The *_json columns hold the denormalized summaries the read-model
  // exposes; the operational tables below are the source for reconciliation.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_runtime (
      thread_id TEXT PRIMARY KEY,
      target_kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      role TEXT NOT NULL,
      runtime_instance_id TEXT,
      status TEXT NOT NULL,
      root_path TEXT,
      instance_json TEXT,
      processes_json TEXT NOT NULL DEFAULT '[]',
      routes_json TEXT NOT NULL DEFAULT '[]',
      snapshots_json TEXT NOT NULL DEFAULT '[]',
      leases_json TEXT NOT NULL DEFAULT '[]',
      last_activity_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS execution_runtime_instances (
      instance_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      root_path TEXT,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS execution_runtime_processes (
      process_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      command TEXT,
      status TEXT NOT NULL,
      exit_code INTEGER,
      failure_reason TEXT,
      tail TEXT,
      started_at TEXT NOT NULL,
      exited_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS execution_runtime_routes (
      route_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      port INTEGER NOT NULL,
      url TEXT,
      label TEXT,
      exposed_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS execution_runtime_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      label TEXT,
      secret_tainted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS execution_runtime_activity_leases (
      lease_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      renewed_at TEXT,
      expires_at TEXT,
      released_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_execution_runtime_instances_thread
    ON execution_runtime_instances(thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_execution_runtime_processes_instance
    ON execution_runtime_processes(instance_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_execution_runtime_routes_instance
    ON execution_runtime_routes(instance_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_execution_runtime_snapshots_instance
    ON execution_runtime_snapshots(instance_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_execution_runtime_activity_leases_instance
    ON execution_runtime_activity_leases(instance_id)
  `;
});
