import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Persist the exact command that owns an in-flight approval response. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_pending_approvals
    ADD COLUMN response_command_id TEXT
  `;
  yield* sql`
    ALTER TABLE projection_pending_approvals
    ADD COLUMN response_requested_at TEXT
  `;
  yield* sql`
    UPDATE projection_pending_approvals
    SET status = 'confirmed'
    WHERE status = 'resolved'
  `;
});
