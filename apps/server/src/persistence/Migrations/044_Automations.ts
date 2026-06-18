import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automation_definitions (
      automation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_thread_id TEXT,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      next_run_at TEXT,
      model_selection_json TEXT NOT NULL,
      provider_options_json TEXT,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      worktree_mode TEXT NOT NULL,
      mode TEXT NOT NULL,
      target_thread_id TEXT,
      max_iterations INTEGER,
      stop_on_error INTEGER NOT NULL,
      iteration_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automation_runs (
      run_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT,
      turn_id TEXT,
      trigger_type TEXT NOT NULL,
      status TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      claimed_by TEXT,
      claimed_at TEXT,
      lease_expires_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      thread_create_command_id TEXT,
      turn_start_command_id TEXT,
      message_id TEXT,
      error TEXT,
      result_json TEXT,
      permission_snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (automation_id) REFERENCES automation_definitions(automation_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automation_scheduler_leases (
      lease_key TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_definitions_due
    ON automation_definitions (enabled, archived_at, next_run_at, automation_id)
  `;

  // Dedupe only scheduled occurrences; manual "run now" runs are never deduped.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_unique_occurrence
    ON automation_runs (automation_id, scheduled_for)
    WHERE trigger_type = 'scheduled'
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_runs_recovery
    ON automation_runs (status, lease_expires_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_runs_history
    ON automation_runs (automation_id, scheduled_for DESC, run_id DESC)
  `;

  // Backs the run-list query, which filters by project and orders by recency.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_runs_project
    ON automation_runs (project_id, scheduled_for DESC, run_id DESC)
  `;

  // Backs reactor lookups that resolve a run from its orchestration thread.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_runs_thread
    ON automation_runs (thread_id, created_at DESC)
  `;
});
