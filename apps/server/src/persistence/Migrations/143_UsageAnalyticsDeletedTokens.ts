// Archives automated token deltas separately from the user-only Profile archive.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS usage_analytics_deleted_tokens (
      thread_id TEXT NOT NULL,
      project_id TEXT,
      created_at TEXT NOT NULL,
      dispatch_origin TEXT NOT NULL CHECK (dispatch_origin IN ('automation', 'agent')),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      tokens INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_usage_analytics_deleted_tokens_thread
    ON usage_analytics_deleted_tokens(thread_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_usage_analytics_deleted_tokens_time
    ON usage_analytics_deleted_tokens(created_at)
  `;
});
