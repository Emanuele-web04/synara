/**
 * Indexes turns by their pending message so the per-turn model lookup (turn-start event →
 * turn) seeks instead of scanning a thread's turns for every event. Profile stats, the
 * delete-time archive, and time-range recaps all run that lookup. Additive only.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_pending_message
    ON projection_turns(thread_id, pending_message_id)
  `;
});
