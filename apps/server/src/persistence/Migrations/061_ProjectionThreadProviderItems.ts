import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_provider_items (
      provider_item_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      item_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_provider_items_thread_created
    ON projection_thread_provider_items(thread_id, created_at, provider_item_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_provider_items_thread_turn
    ON projection_thread_provider_items(thread_id, turn_id)
  `;
});
