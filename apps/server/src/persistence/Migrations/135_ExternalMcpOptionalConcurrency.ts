import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly required: number }>`
    SELECT "notnull" AS required FROM pragma_table_info('external_mcp_integrations')
    WHERE name = 'concurrency_limit'
  `;
  if (columns[0]?.required === 0) return;

  // Replace just this column, preserving the parent table identity, credentials,
  // grants and child foreign keys. Existing pairings keep their chosen cap.
  yield* sql`
    ALTER TABLE external_mcp_integrations
    ADD COLUMN optional_concurrency_limit INTEGER
      CHECK (optional_concurrency_limit BETWEEN 1 AND 100)
  `;
  yield* sql`
    UPDATE external_mcp_integrations SET optional_concurrency_limit = concurrency_limit
  `;
  yield* sql`ALTER TABLE external_mcp_integrations DROP COLUMN concurrency_limit`;
  yield* sql`
    ALTER TABLE external_mcp_integrations
    RENAME COLUMN optional_concurrency_limit TO concurrency_limit
  `;
});
