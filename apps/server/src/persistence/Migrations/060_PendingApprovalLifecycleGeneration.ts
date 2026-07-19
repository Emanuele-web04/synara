import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists, tableExists } from "./schemaHelpers.ts";

/** Bind a projected provider request to the exact runtime incarnation that emitted it. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* tableExists(sql, "projection_pending_approvals"))) {
    return;
  }
  if (yield* columnExists(sql, "projection_pending_approvals", "lifecycle_generation")) {
    return;
  }
  yield* sql`
    ALTER TABLE projection_pending_approvals
    ADD COLUMN lifecycle_generation TEXT
  `;
});
