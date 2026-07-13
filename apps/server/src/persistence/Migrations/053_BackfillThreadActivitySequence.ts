// FILE: 053_BackfillThreadActivitySequence.ts
// Purpose: Restores deterministic ordering for legacy thread activities.
// Layer: SQLite migration
// Depends on: orchestration_events as the authoritative append order.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    WITH activity_sequences AS MATERIALIZED (
      SELECT
        json_extract(payload_json, '$.activity.id') AS activity_id,
        sequence
      FROM orchestration_events
      WHERE event_type = 'thread.activity-appended'
    )
    UPDATE projection_thread_activities
    SET sequence = (
      SELECT activity_sequences.sequence
      FROM activity_sequences
      WHERE activity_sequences.activity_id = projection_thread_activities.activity_id
    )
    WHERE sequence IS NULL
      AND EXISTS (
        SELECT 1
        FROM activity_sequences
        WHERE activity_sequences.activity_id = projection_thread_activities.activity_id
      )
  `;
});
