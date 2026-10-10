/** repairs imports whose tracker used ID 36 for a foreign migration — our pinned column was skipped though queries require it */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (yield* columnExists(sql, "projection_threads", "is_pinned")) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0
  `;
});
