import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const tables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'projection_thread_activities'
  `;
  if (tables.length === 0) {
    return;
  }

  yield* sql`
    UPDATE projection_thread_activities
    SET summary = 'MCP authentication required'
    WHERE kind = 'runtime.warning'
      AND summary = 'Runtime warning'
      AND payload_json LIKE '%rmcp::transport::worker%'
      AND payload_json LIKE '%AuthRequired%'
      AND payload_json LIKE '%www_authenticate_header%'
  `;

  yield* sql`
    UPDATE projection_thread_activities
    SET summary = 'Codex thread resume unavailable'
    WHERE kind = 'runtime.warning'
      AND summary = 'Runtime warning'
      AND payload_json LIKE '%thread/resume failed: no rollout found for thread id%'
  `;
});
