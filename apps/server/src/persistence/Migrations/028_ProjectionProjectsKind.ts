import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    name: string;
  }>`
    SELECT name
    FROM pragma_table_info('projection_projects')
    WHERE name = 'kind'
  `;

  if (columns.length > 0) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'project'
  `;
});
