import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('agent_gateway_operations')
  `;
  if (!columns.some(({ name }) => name === "caller_purged_at")) {
    yield* sql`ALTER TABLE agent_gateway_operations ADD COLUMN caller_purged_at TEXT`;
  }
});
