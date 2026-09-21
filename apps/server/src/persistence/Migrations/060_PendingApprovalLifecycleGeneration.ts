import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists, tableExists } from "./schemaHelpers.ts";

/** bind a projected request to the exact runtime incarnation that emitted it */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // migration 62 retires this table — on a 54.. replay the column already lives on projection_pending_interactions
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
