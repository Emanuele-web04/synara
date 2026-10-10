import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Additive: Auto-fix CI is opt-in in Stable and Beta. One row per watched
// pull request of a chat, so a chat can watch every PR of a stack.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_auto_fix (
      thread_id TEXT NOT NULL,
      pull_request_url TEXT NOT NULL,
      requested_pull_request_url TEXT,
      status TEXT NOT NULL,
      pause_reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_handled_head_sha TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, pull_request_url)
    )
  `;
  // A reconciled/private lineage can already have the original table shape.
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(pull_request_auto_fix)`;
  if (!columns.some((column) => column.name === "requested_pull_request_url")) {
    yield* sql`ALTER TABLE pull_request_auto_fix ADD COLUMN requested_pull_request_url TEXT`;
  }
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS pull_request_auto_fix_active_owner
    ON pull_request_auto_fix (pull_request_url) WHERE status <> 'paused'`;
});
