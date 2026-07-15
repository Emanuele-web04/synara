// FILE: 053_BackfillThreadActivitySequence.ts
// Purpose: Restores deterministic ordering for legacy thread activities.
// Layer: SQLite migration
// Depends on: orchestration_events as the authoritative append order.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A correlated lookup over a materialized CTE becomes quadratic on large
  // histories. Build an indexed temporary lookup once, then backfill each
  // projection row through its primary key.
  yield* sql`DROP TABLE IF EXISTS temp_synara_activity_sequences`;

  yield* sql`
    CREATE TEMP TABLE temp_synara_activity_sequences (
      activity_id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL
    ) WITHOUT ROWID
  `;

  yield* sql`
    INSERT INTO temp_synara_activity_sequences (activity_id, sequence)
    SELECT
      json_extract(payload_json, '$.activity.id') AS activity_id,
      MAX(sequence) AS sequence
    FROM orchestration_events
    WHERE event_type = 'thread.activity-appended'
      AND json_type(payload_json, '$.activity.id') = 'text'
    GROUP BY activity_id
  `;

  yield* sql`
    UPDATE projection_thread_activities
    SET sequence = (
      SELECT temp_synara_activity_sequences.sequence
      FROM temp_synara_activity_sequences
      WHERE temp_synara_activity_sequences.activity_id = projection_thread_activities.activity_id
    )
    WHERE sequence IS NULL
      AND EXISTS (
        SELECT 1
        FROM temp_synara_activity_sequences
        WHERE temp_synara_activity_sequences.activity_id = projection_thread_activities.activity_id
      )
  `;

  yield* sql`DROP TABLE temp_synara_activity_sequences`;
});
