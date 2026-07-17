import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Identifies the exact provider runtime incarnation that owns a thread.
 * Legacy rows remain routable but are explicitly distinguishable from every
 * newly started or recovered runtime, which receives an opaque UUID.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE provider_session_runtime
    ADD COLUMN lifecycle_generation TEXT NOT NULL DEFAULT 'legacy'
  `;
});
