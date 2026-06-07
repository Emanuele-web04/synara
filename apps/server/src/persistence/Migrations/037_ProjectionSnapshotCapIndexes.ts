import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_created_desc
    ON projection_thread_messages(thread_id, created_at DESC, message_id DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_rank_desc
    ON projection_thread_activities(
      thread_id,
      (CASE WHEN sequence IS NULL THEN 0 ELSE 1 END) DESC,
      sequence DESC,
      created_at DESC,
      activity_id DESC
    )
  `;
});
