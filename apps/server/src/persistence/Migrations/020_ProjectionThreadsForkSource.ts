/**
 * Tracks the source thread for forked conversations so provider-native
 * session forking can happen lazily when the target thread opens.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN fork_source_thread_id TEXT
  `.pipe(Effect.catchTag("SqlError", () => Effect.void));
});
