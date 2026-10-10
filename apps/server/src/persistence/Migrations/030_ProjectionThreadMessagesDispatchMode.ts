// projected dispatch-mode metadata so user messages render steer chips after reloads

import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{
    name: string;
  }>`
    SELECT name
    FROM pragma_table_info('projection_thread_messages')
    WHERE name = 'dispatch_mode'
  `;

  if (columns.length > 0) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN dispatch_mode TEXT
  `;
});
