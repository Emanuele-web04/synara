import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PROVIDER_RUNTIME_INGESTION_CONSUMER } from "../Services/ProviderRuntimeEvents.ts";

// Provider output is journaled before live publication. The consumer cursor is
// intentionally independent from orchestration event sequences: it advances
// only after ProviderRuntimeIngestion accepts the exact journal row.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const migratedAt = new Date().toISOString();

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_runtime_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      lifecycle_generation TEXT,
      event_type TEXT NOT NULL,
      event_json TEXT NOT NULL
        CHECK (length(CAST(event_json AS BLOB)) <= 2097152),
      persisted_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_runtime_events_thread_sequence
    ON provider_runtime_events(thread_id, sequence)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_runtime_events_turn_sequence
    ON provider_runtime_events(thread_id, turn_id, sequence)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_runtime_open_turns (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      first_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_runtime_event_consumers (
      consumer_name TEXT PRIMARY KEY,
      last_acked_sequence INTEGER NOT NULL DEFAULT 0
        CHECK (last_acked_sequence >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO provider_runtime_event_consumers (
      consumer_name, last_acked_sequence, created_at, updated_at
    ) VALUES (
      ${PROVIDER_RUNTIME_INGESTION_CONSUMER}, 0, ${migratedAt}, ${migratedAt}
    )
    ON CONFLICT (consumer_name) DO NOTHING
  `;
});
