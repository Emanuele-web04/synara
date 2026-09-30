import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Personal to-dos for the Tasks view. No foreign keys to projections: projects and
  // threads are rebuilt from events, and a user's to-dos must survive that. A stale
  // project or thread id is tolerated by the client.
  yield* sql`CREATE TABLE IF NOT EXISTS todos (
    todo_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'none'
      CHECK (priority IN ('none', 'low', 'medium', 'high', 'urgent')),
    project_id TEXT,
    due_date TEXT,
    thread_id TEXT,
    delegation_base_turn_id TEXT,
    linked_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_todos_created_at ON todos(created_at)`;
  // One chat works on one open to-do; the service's check reports it nicely, this makes
  // concurrent claims of the same chat unable to both succeed.
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_open_thread
    ON todos(thread_id) WHERE thread_id IS NOT NULL AND completed_at IS NULL`;
});
