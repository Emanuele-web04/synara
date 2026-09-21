import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { primaryKeyColumns, tableExists } from "./schemaHelpers.ts";

/** scope provider request ids to their owning thread without discarding legacy rows */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // migration 62 retires this table — on a 54.. replay there's no legacy table; guard on pre-state or a replay would discard settled rows
  if (!(yield* tableExists(sql, "projection_pending_approvals"))) {
    return;
  }
  const primaryKey = yield* primaryKeyColumns(sql, "projection_pending_approvals");
  if (primaryKey.includes("thread_id")) {
    return;
  }

  yield* sql`DROP TABLE IF EXISTS projection_pending_approvals_v58`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_pending_approvals_v58 (
      request_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      status TEXT NOT NULL,
      decision TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      PRIMARY KEY (thread_id, request_id)
    )
  `;
  yield* sql`
    INSERT INTO projection_pending_approvals_v58 (
      request_id,
      thread_id,
      turn_id,
      status,
      decision,
      created_at,
      resolved_at
    )
    SELECT
      request_id,
      thread_id,
      turn_id,
      status,
      decision,
      created_at,
      resolved_at
    FROM projection_pending_approvals
  `;
  yield* sql`DROP TABLE projection_pending_approvals`;
  yield* sql`
    ALTER TABLE projection_pending_approvals_v58
    RENAME TO projection_pending_approvals
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_pending_approvals_thread_status
    ON projection_pending_approvals(thread_id, status)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_pending_approvals_request_id
    ON projection_pending_approvals(request_id)
  `;
});
