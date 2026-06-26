import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!columns.some((column) => column.name === "provider_instance_id")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN provider_instance_id TEXT
    `;
  }

  yield* sql`
    UPDATE projection_thread_sessions
    SET provider_instance_id = (
      SELECT json_extract(projection_threads.model_selection_json, '$.instanceId')
      FROM projection_threads
      WHERE projection_threads.thread_id = projection_thread_sessions.thread_id
    )
    WHERE provider_instance_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM projection_threads
        WHERE projection_threads.thread_id = projection_thread_sessions.thread_id
          AND json_extract(projection_threads.model_selection_json, '$.instanceId') IS NOT NULL
      )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_sessions_provider_instance
    ON projection_thread_sessions(provider_instance_id)
  `;
});
