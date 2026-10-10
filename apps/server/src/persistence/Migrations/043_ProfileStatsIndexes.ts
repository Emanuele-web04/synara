/**
 * Adds lightweight covering indexes for Profile stats queries.
 * These support prompt bucketing, per-turn model events, and token delta scans.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_profile_prompt_activity
    ON projection_thread_messages(role, source, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_events_profile_turn_events
    ON orchestration_events(event_type, stream_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_profile_token_activity
    ON projection_thread_activities(kind, thread_id, sequence, created_at, activity_id)
  `;
});
