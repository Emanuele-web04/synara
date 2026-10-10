import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS queued_turn_promotions (
      queued_event_sequence INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      dispatch_mode TEXT NOT NULL CHECK (dispatch_mode IN ('queue', 'steer')),
      state TEXT NOT NULL CHECK (state IN ('queued', 'promoting', 'promoted', 'cancelled')),
      claim_owner TEXT,
      claimed_at TEXT,
      claim_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      promoted_at TEXT,
      FOREIGN KEY (queued_event_sequence) REFERENCES orchestration_events(sequence) ON DELETE RESTRICT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_queued_turn_promotions_thread_state_order
    ON queued_turn_promotions(thread_id, state, dispatch_mode, queued_event_sequence)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_queued_turn_promotions_state_expiry
    ON queued_turn_promotions(state, claim_expires_at)
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_queued_turn_promotions_active_message
    ON queued_turn_promotions(thread_id, message_id)
    WHERE state IN ('queued', 'promoting')
  `;
});
