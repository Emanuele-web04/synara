import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "automation_definitions", "managed_by_project"))) {
    yield* sql.unsafe(`
      ALTER TABLE automation_definitions
      ADD COLUMN managed_by_project INTEGER NOT NULL DEFAULT 0
    `);
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_agent_configs (
      project_id TEXT PRIMARY KEY,
      coordinator_thread_id TEXT NOT NULL,
      coordinator_name TEXT NOT NULL,
      coordinator_model_selection_json TEXT NOT NULL,
      coordinator_provider_options_json TEXT,
      worker_routing_json TEXT,
      limits_json TEXT NOT NULL,
      capture_enabled INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      automation_id TEXT,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      disabled_at TEXT
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_agent_configs_coordinator
    ON project_agent_configs (coordinator_thread_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_agent_goals (
      goal_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      authorization_source TEXT NOT NULL,
      scope_version INTEGER NOT NULL,
      acceptance_criteria TEXT,
      limits_json TEXT NOT NULL,
      status TEXT NOT NULL,
      continuation_count INTEGER NOT NULL,
      worker_creation_count INTEGER NOT NULL,
      authorized_at TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES project_agent_configs(project_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_agent_goals_project
    ON project_agent_goals (project_id, updated_at DESC, goal_id DESC)
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_agent_goals_one_open
    ON project_agent_goals (project_id)
    WHERE status IN ('active', 'paused')
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_agent_tasks (
      task_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      acceptance_criteria TEXT,
      status TEXT NOT NULL,
      assigned_thread_id TEXT,
      repair_count INTEGER NOT NULL,
      archived_at TEXT,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (goal_id) REFERENCES project_agent_goals(goal_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_agent_tasks_goal
    ON project_agent_tasks (project_id, goal_id, created_at DESC, task_id DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_agent_task_dependencies (
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      PRIMARY KEY (task_id, depends_on_task_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_agent_task_attempts (
      attempt_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      worker_thread_id TEXT NOT NULL,
      gateway_operation_id TEXT,
      request_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY (task_id) REFERENCES project_agent_tasks(task_id)
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_agent_attempts_request
    ON project_agent_task_attempts (request_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_agent_attempts_task
    ON project_agent_task_attempts (task_id, attempt_number DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_agent_evidence (
      evidence_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT,
      attempt_id TEXT,
      kind TEXT NOT NULL,
      classification TEXT NOT NULL,
      author_kind TEXT NOT NULL,
      author_thread_id TEXT,
      source_thread_id TEXT,
      source_message_id TEXT,
      source_turn_id TEXT,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_agent_evidence_task
    ON project_agent_evidence (project_id, task_id, created_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_agent_documents (
      revision_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      logical_path TEXT NOT NULL,
      revision INTEGER NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      author_kind TEXT NOT NULL,
      author_thread_id TEXT,
      sources_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_agent_documents_revision
    ON project_agent_documents (project_id, logical_path, revision)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_agent_document_heads (
      project_id TEXT NOT NULL,
      logical_path TEXT NOT NULL,
      revision INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      disk_hash TEXT,
      conflict_pending INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, logical_path)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_agent_activity (
      activity_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_thread_id TEXT,
      goal_id TEXT,
      task_id TEXT,
      source_json TEXT,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_agent_activity_sequence
    ON project_agent_activity (project_id, sequence)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_agent_activity_project
    ON project_agent_activity (project_id, sequence DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_agent_digests (
      project_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      focus_items_json TEXT NOT NULL,
      coverage_from_sequence INTEGER NOT NULL,
      coverage_to_sequence INTEGER NOT NULL,
      historical_coverage TEXT NOT NULL,
      summarized_thread_count INTEGER NOT NULL,
      pending_thread_count INTEGER NOT NULL,
      generation_state TEXT NOT NULL,
      generated_at TEXT,
      last_good_at TEXT,
      last_error TEXT,
      pinned_focus_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_agent_event_inbox (
      inbox_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      task_id TEXT,
      eligible_wake INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_agent_inbox_source
    ON project_agent_event_inbox (source_event_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_agent_inbox_project
    ON project_agent_event_inbox (project_id, created_at ASC, inbox_id ASC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_agent_cursors (
      project_id TEXT PRIMARY KEY,
      processed_through_inbox_id TEXT,
      frozen_from_inbox_id TEXT,
      frozen_to_inbox_id TEXT,
      coordinator_busy INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_agent_thread_index (
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      excluded INTEGER NOT NULL,
      archived INTEGER NOT NULL,
      summary_status TEXT NOT NULL,
      last_updated_at TEXT,
      last_summarized_at TEXT,
      PRIMARY KEY (project_id, thread_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_agent_thread_index_updated
    ON project_agent_thread_index (project_id, last_updated_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_agent_receipts (
      request_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_agent_receipts_project
    ON project_agent_receipts (project_id, created_at DESC)
  `;
});
