import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists, tableExists } from "./schemaHelpers.ts";

/** Persist the exact command that owns an in-flight approval response. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Migration 62 retires this table; on a replay of the 54.. range the settled
  // state already lives on projection_pending_interactions.
  if (!(yield* tableExists(sql, "projection_pending_approvals"))) {
    return;
  }
  if (!(yield* columnExists(sql, "projection_pending_approvals", "response_command_id"))) {
    yield* sql`
      ALTER TABLE projection_pending_approvals
      ADD COLUMN response_command_id TEXT
    `;
  }
  if (!(yield* columnExists(sql, "projection_pending_approvals", "response_requested_at"))) {
    yield* sql`
      ALTER TABLE projection_pending_approvals
      ADD COLUMN response_requested_at TEXT
    `;
  }
  // Naturally re-runnable: the rename is a one-way status projection and no row
  // is left in the 'resolved' state once it has been applied.
  yield* sql`
    UPDATE projection_pending_approvals
    SET status = 'confirmed'
    WHERE status = 'resolved'
  `;
});
