/**
 * Repairs imported legacy DBs whose migration tracker already used ID 36 for
 * a pre-Synara migration, causing Synara's pinned thread column migration to
 * be skipped even though read-model queries now require the column.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ name: string }>`
    SELECT name
    FROM pragma_table_info('projection_threads')
    WHERE name = 'is_pinned'
  `;

  if (columns.length > 0) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0
  `;
});
