/**
 * Tracks sidechat source threads separately from durable forks.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ name: string }>`
    SELECT name
    FROM pragma_table_info('projection_threads')
    WHERE name = 'sidechat_source_thread_id'
  `;

  if (columns.length > 0) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN sidechat_source_thread_id TEXT
  `;
});
