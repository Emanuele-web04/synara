import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS review_walkthroughs (
      repository_id TEXT NOT NULL,
      reference TEXT NOT NULL,
      patch_signature TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (repository_id, reference, patch_signature)
    )
  `;
});
