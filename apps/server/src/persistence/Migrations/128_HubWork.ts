import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_agent_work_items (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      task_index INTEGER NOT NULL,
      state TEXT NOT NULL,
      worker_thread_id TEXT,
      slot_held INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      UNIQUE (project_id, scope_key, task_index)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_agent_work_queue
    ON project_agent_work_items (project_id, state, sequence)
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_agent_work_worker
    ON project_agent_work_items (worker_thread_id)
    WHERE worker_thread_id IS NOT NULL
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_agent_work_requests (
      project_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      PRIMARY KEY (project_id, request_id)
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO project_agent_work_requests (project_id, request_id, scope_key, fingerprint)
    SELECT project_id, json_extract(record_json, '$.requestId'), scope_key,
      json_extract(record_json, '$.fingerprint')
    FROM project_agent_work_items
    ORDER BY sequence
  `;
});
