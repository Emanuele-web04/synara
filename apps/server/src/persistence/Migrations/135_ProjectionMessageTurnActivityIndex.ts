import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Reconciliation runs every five seconds. Seek only the in-flight turns and
// read their activity from the index instead of scanning old message bodies.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_turn_activity
    ON projection_thread_messages(thread_id, turn_id, updated_at)
  `;
});
