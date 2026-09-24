import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Every thread the coordinator creates is a tracked worker — with or without
  // an active goal — so settle, roll-up, and stuck detection have a durable
  // record to drive. Tasks still link back via task_id when a goal exists.
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS project_agent_managed_workers (
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      title TEXT NOT NULL,
      task_id TEXT,
      settled_at TEXT,
      settle_outcome TEXT,
      waiting_since TEXT,
      stuck_kind TEXT,
      stuck_since TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, thread_id)
    )
  `);

  yield* sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_agent_workers_thread
    ON project_agent_managed_workers (thread_id)
  `);

  yield* sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_project_agent_workers_batch
    ON project_agent_managed_workers (project_id, batch_id)
  `);
});
