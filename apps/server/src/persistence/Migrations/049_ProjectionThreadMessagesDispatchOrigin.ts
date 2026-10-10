/** dispatch_origin badges automation-dispatched user turns distinctly; NULL = human send */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_thread_messages", "dispatch_origin"))) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN dispatch_origin TEXT
    `;
  }
});
