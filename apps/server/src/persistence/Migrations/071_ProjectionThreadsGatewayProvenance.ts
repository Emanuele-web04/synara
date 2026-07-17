import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')
  `;
  const existing = new Set(columns.map(({ name }) => name));

  if (!existing.has("creation_source")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN creation_source TEXT`;
  }
  if (!existing.has("source_thread_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN source_thread_id TEXT`;
  }
  if (!existing.has("source_turn_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN source_turn_id TEXT`;
  }
  if (!existing.has("gateway_operation_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN gateway_operation_id TEXT`;
  }
  if (!existing.has("gateway_operation_index")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN gateway_operation_index INTEGER`;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_gateway_operation
    ON projection_threads (gateway_operation_id, gateway_operation_index)
  `;
});
