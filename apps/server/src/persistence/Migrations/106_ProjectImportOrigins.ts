import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// import provenance outlives runtime bindings, archives, soft-deleted tasks
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_import_origins (
      source_key TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL,
      source_home TEXT NOT NULL,
      external_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
      created_at TEXT NOT NULL,
      UNIQUE(provider, source_home, external_id)
    )
  `;
});
