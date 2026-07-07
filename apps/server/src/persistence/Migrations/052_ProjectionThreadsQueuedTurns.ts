// FILE: 052_ProjectionThreadsQueuedTurns.ts
// Purpose: Adds durable queued-turn recovery state to projected thread rows.
// Depends on: projection_threads and the migration schema helpers.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_threads", "queued_turns_json"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN queued_turns_json TEXT
    `;
  }
});
