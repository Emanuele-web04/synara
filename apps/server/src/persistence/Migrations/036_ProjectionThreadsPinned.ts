/**
 * Adds durable pin state to projected threads so server-side retention can
 * protect pinned conversations without depending on browser local storage.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0
  `.pipe(
    Effect.catchTag("SqlError", (error) =>
      String(error).includes("duplicate column name")
        ? Effect.void
        : Effect.fail(error),
    ),
  );
});
