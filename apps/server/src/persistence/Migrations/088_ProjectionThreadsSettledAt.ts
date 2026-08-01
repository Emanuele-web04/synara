/**
 * Adds a durable settled_at marker for the Activity View task lifecycle:
 * settled threads stay visible but drop to the dimmed "Settled" section.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN settled_at TEXT
  `.pipe(Effect.catchTag("SqlError", () => Effect.void));
});
