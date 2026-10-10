import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS git_handoff_operations (
      command_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      input_json TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('pending', 'git_applied', 'completed', 'uncertain')),
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_git_handoff_operations_recovery
    ON git_handoff_operations(phase, updated_at, command_id)
  `;
});
