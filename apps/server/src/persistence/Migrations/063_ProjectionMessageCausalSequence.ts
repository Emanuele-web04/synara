import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

/** Make orchestration sequence, not provider time, the projected message order. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "projection_thread_messages", "sequence"))) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN sequence INTEGER
    `;
  }
  yield* sql`
    UPDATE projection_thread_messages
    SET sequence = COALESCE(
      sequence,
      (
        SELECT MIN(events.sequence)
        FROM orchestration_events AS events
        WHERE events.aggregate_kind = 'thread'
          AND events.stream_id = projection_thread_messages.thread_id
          AND events.event_type = 'thread.message-sent'
          AND json_extract(events.payload_json, '$.messageId') = projection_thread_messages.message_id
      )
    )
    WHERE sequence IS NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_sequence
    ON projection_thread_messages(thread_id, sequence, message_id)
  `;
});
