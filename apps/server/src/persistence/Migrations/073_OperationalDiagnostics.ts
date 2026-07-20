import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS operational_diagnostics (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT,
      source TEXT NOT NULL CHECK (source IN ('server', 'browser')),
      diagnostic_kind TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
      code TEXT,
      detail_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_operational_diagnostics_thread_sequence
    ON operational_diagnostics(thread_id, sequence DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_operational_diagnostics_occurred_at
    ON operational_diagnostics(occurred_at)
  `;
});
