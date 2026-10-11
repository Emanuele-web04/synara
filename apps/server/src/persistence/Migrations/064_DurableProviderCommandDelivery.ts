import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PROVIDER_COMMAND_REACTOR_CONSUMER } from "../Services/OrchestrationEventDeliveries.ts";

// Activates durable provider-command delivery at the exact event-log high-water
// mark. Older events were handled by the former live-only reactor and must not
// be replayed into providers. Private builds that created these tables under
// reserved migration 54 converge through the idempotent DDL and cursor insert.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const migratedAt = new Date().toISOString();

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_consumer_state (
      consumer_name TEXT PRIMARY KEY,
      last_acked_sequence INTEGER NOT NULL CHECK (last_acked_sequence >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_event_deliveries (
      consumer_name TEXT NOT NULL,
      event_sequence INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN ('inflight', 'retry', 'succeeded', 'dead', 'uncertain')
      ),
      claim_owner TEXT,
      claimed_at TEXT,
      claim_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (consumer_name, event_sequence),
      FOREIGN KEY (consumer_name)
        REFERENCES orchestration_consumer_state(consumer_name)
        ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_event_deliveries_state_sequence
    ON orchestration_event_deliveries(consumer_name, state, event_sequence)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_event_deliveries_thread_state
    ON orchestration_event_deliveries(consumer_name, thread_id, state, event_sequence)
  `;

  yield* sql`
    INSERT INTO orchestration_consumer_state (
      consumer_name,
      last_acked_sequence,
      created_at,
      updated_at
    )
    SELECT
      ${PROVIDER_COMMAND_REACTOR_CONSUMER},
      COALESCE(MAX(sequence), 0),
      ${migratedAt},
      ${migratedAt}
    FROM orchestration_events
    WHERE 1 = 1
    ON CONFLICT (consumer_name) DO NOTHING
  `;
});
