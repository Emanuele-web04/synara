import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists, tableExists } from "./schemaHelpers.ts";

/** Bind a projected provider request to the exact runtime incarnation that emitted it. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Migration 62 retires this table; on a replay of the 54.. range the column
  // already lives on projection_pending_interactions and there is nothing to add.
  if (!(yield* tableExists(sql, "projection_pending_approvals"))) {
    return;
  }
  if (!(yield* columnExists(sql, "projection_pending_approvals", "lifecycle_generation"))) {
    yield* sql`
      ALTER TABLE projection_pending_approvals
      ADD COLUMN lifecycle_generation TEXT
    `;
  }
});
