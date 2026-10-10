import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { columnExists } from "./schemaHelpers.ts";

// Preserve existing rows and projector cursors. Streaming bodies move lazily
// into chunks; completed/imported history requires no backfill.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "projection_thread_messages", "text_event_sequence"))) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN text_event_sequence INTEGER NOT NULL DEFAULT 0`;
  }
  for (const table of ["projection_thread_messages", "message_text_segments"]) {
    if (!(yield* columnExists(sql, table, "text_json"))) {
      yield* sql`ALTER TABLE ${sql.literal(table)} ADD COLUMN text_json TEXT`;
    }
  }
  yield* sql`
    CREATE TABLE IF NOT EXISTS message_text_chunks (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      event_sequence INTEGER NOT NULL,
      segment_sequence INTEGER,
      text_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, message_id, event_sequence),
      FOREIGN KEY (thread_id, message_id)
        REFERENCES projection_thread_messages(thread_id, message_id) ON DELETE CASCADE
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_message_text_chunks_segment ON message_text_chunks(thread_id, message_id, segment_sequence, event_sequence)`;
});
