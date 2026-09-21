/** ordered slices of streamed assistant text between row-making provider events — the web timeline interleaves them with tool rows in execution order; append-only during streaming; completed messages retain rows only at tool boundaries */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS message_text_segments (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (thread_id, message_id, sequence)
    )
  `;
});
