/**
 * Adds a durable archived_at marker so legacy thread.archived/thread.unarchived
 * events can keep their semantics during replay instead of being normalized away.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN archived_at TEXT
  `.pipe(Effect.catchTag("SqlError", () => Effect.void));
});
