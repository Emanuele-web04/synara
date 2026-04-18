import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{
    name: string;
  }>`
    SELECT name
    FROM pragma_table_info('projection_threads')
    WHERE name = 'last_known_pr_json'
  `;

  if (columns.length > 0) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN last_known_pr_json TEXT
  `;
});
