import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Consolidate approvals and user input under one kind-scoped settlement authority. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS projection_pending_interactions_v62`;
  yield* sql`
    CREATE TABLE projection_pending_interactions_v62 (
      interaction_kind TEXT NOT NULL,
      request_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      lifecycle_generation TEXT,
      status TEXT NOT NULL,
      decision TEXT,
      response_command_id TEXT,
      response_requested_at TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      PRIMARY KEY (thread_id, interaction_kind, request_id)
    )
  `;
  yield* sql`
    INSERT INTO projection_pending_interactions_v62 (
      interaction_kind,
      request_id,
      thread_id,
      turn_id,
      lifecycle_generation,
      status,
      decision,
      response_command_id,
      response_requested_at,
      created_at,
      resolved_at
    )
    SELECT
      'approval',
      request_id,
      thread_id,
      turn_id,
      lifecycle_generation,
      status,
      decision,
      response_command_id,
      response_requested_at,
      created_at,
      resolved_at
    FROM projection_pending_approvals
  `;
  yield* sql`DROP TABLE projection_pending_approvals`;
  yield* sql`
    ALTER TABLE projection_pending_interactions_v62
    RENAME TO projection_pending_interactions
  `;
  yield* sql`
    CREATE INDEX idx_projection_pending_interactions_thread_kind_status
    ON projection_pending_interactions(thread_id, interaction_kind, status)
  `;
  yield* sql`
    CREATE INDEX idx_projection_pending_interactions_request_id
    ON projection_pending_interactions(request_id)
  `;
  yield* sql`
    DELETE FROM projection_state
    WHERE projector = 'projection.pending-approvals'
  `;
});
