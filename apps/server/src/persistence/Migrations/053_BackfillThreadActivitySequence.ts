// restores deterministic ordering for legacy thread activities

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // a correlated lookup over a materialized CTE is quadratic on large histories — build an indexed temp lookup once, then backfill by primary key
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
