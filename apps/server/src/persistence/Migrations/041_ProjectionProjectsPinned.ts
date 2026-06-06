/**
 * Adds durable pin state to projected projects so project sidebar pins survive
 * browser restarts and can be reflected in shell snapshots.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0
  `.pipe(
    Effect.catchTag("SqlError", (error) =>
      String(error).includes("duplicate column name") ? Effect.void : Effect.fail(error),
    ),
  );
});
