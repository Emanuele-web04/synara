import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly exists: number }>`
    SELECT EXISTS(
      SELECT 1 FROM pragma_table_info('external_mcp_integrations')
      WHERE name = 'project_scope'
    ) AS "exists"
  `;
  if (columns[0]?.exists !== 1) {
    yield* sql.unsafe(`
      ALTER TABLE external_mcp_integrations
      ADD COLUMN project_scope TEXT NOT NULL DEFAULT 'selected'
      CHECK (project_scope IN ('all', 'selected'))
    `);
  }
});
