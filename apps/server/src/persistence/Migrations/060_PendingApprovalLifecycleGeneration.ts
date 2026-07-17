import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Bind a projected provider request to the exact runtime incarnation that emitted it. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_pending_approvals
    ADD COLUMN lifecycle_generation TEXT
  `;
});
