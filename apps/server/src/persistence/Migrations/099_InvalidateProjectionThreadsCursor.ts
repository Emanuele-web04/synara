import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// a cursor already past the newly-covered events would never backfill them — deleting it forces bootstrap to replay the journal with the updated filter, healing regressed updated_at without the manual repairState path
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DELETE FROM projection_state
    WHERE projector = 'projection.threads'
  `;
});
