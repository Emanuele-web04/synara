/**
 * Persists the effective turn-boundary decision for user messages. Requested
 * steer mode alone is insufficient: providers without native steering promote
 * the message into a separate queued turn.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_thread_messages", "starts_new_turn"))) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN starts_new_turn INTEGER
    `;
  }
});
