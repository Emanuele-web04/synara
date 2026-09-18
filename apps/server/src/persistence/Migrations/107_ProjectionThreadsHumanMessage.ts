import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (yield* columnExists(sql, "projection_threads", "latest_human_message_at")) return;

  yield* sql`ALTER TABLE projection_threads ADD COLUMN latest_human_message_at TEXT`;
  yield* sql`
    UPDATE projection_threads
    SET latest_human_message_at = (
      SELECT MAX(MAX(message.created_at, message.updated_at))
      FROM projection_thread_messages AS message
      WHERE message.thread_id = projection_threads.thread_id
        AND message.role = 'user'
        AND (message.dispatch_origin IS NULL OR message.dispatch_origin = 'user')
    )
  `;
});
