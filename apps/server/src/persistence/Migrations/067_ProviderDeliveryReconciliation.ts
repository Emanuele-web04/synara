import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Operator reconciliation is append-only evidence. The delivery row may move
// back to retry or forward to succeeded, but the decision that authorized that
// transition remains attached to the exact consumer/event owner.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_delivery_reconciliations (
      reconciliation_id TEXT PRIMARY KEY,
      consumer_name TEXT NOT NULL,
      event_sequence INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      previous_state TEXT NOT NULL CHECK (previous_state IN ('dead', 'uncertain')),
      outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'safe_retry', 'abandon')),
      reconciled_by TEXT NOT NULL,
      note TEXT,
      reconciled_at TEXT NOT NULL,
      FOREIGN KEY (consumer_name, event_sequence)
        REFERENCES orchestration_event_deliveries(consumer_name, event_sequence)
        ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_delivery_reconciliations_delivery
    ON provider_delivery_reconciliations(consumer_name, event_sequence, reconciled_at DESC)
  `;
});
