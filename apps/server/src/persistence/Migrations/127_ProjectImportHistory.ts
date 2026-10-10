import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Additive: existing completed imports already contain their full transcript.
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_import_history (
      thread_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      PRIMARY KEY (thread_id, revision)
    )
  `;
});
