import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("BackfillThreadActivitySequence", (it) => {
  it.effect("backfills large activity histories through an indexed lookup", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });

      yield* sql`
        WITH RECURSIVE activity_number(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1
          FROM activity_number
          WHERE value < 10000
        )
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        SELECT
          printf('event-%06d', value),
          'thread',
          'thread-large-history',
          value,
          'thread.activity-appended',
          '2026-07-13T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          'provider',
          json_object('activity', json_object('id', printf('activity-%06d', value))),
          '{}'
        FROM activity_number
      `;

      yield* sql`
        WITH RECURSIVE activity_number(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1
          FROM activity_number
          WHERE value < 10000
        )
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at,
          sequence
        )
        SELECT
          printf('activity-%06d', value),
          'thread-large-history',
          NULL,
          'info',
          'test.activity',
          'Test activity',
          '{}',
          '2026-07-13T00:00:00.000Z',
          NULL
        FROM activity_number
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 53 });
      assert.deepStrictEqual(executed, [[53, "BackfillThreadActivitySequence"]]);

      const [result] = yield* sql<{
        readonly missing_sequence_count: number;
        readonly mismatched_sequence_count: number;
      }>`
        SELECT
          SUM(CASE WHEN activity.sequence IS NULL THEN 1 ELSE 0 END) AS missing_sequence_count,
          SUM(CASE WHEN activity.sequence != event.sequence THEN 1 ELSE 0 END)
            AS mismatched_sequence_count
        FROM projection_thread_activities AS activity
        JOIN orchestration_events AS event
          ON json_extract(event.payload_json, '$.activity.id') = activity.activity_id
        WHERE event.event_type = 'thread.activity-appended'
      `;

      assert.deepStrictEqual(result, {
        missing_sequence_count: 0,
        mismatched_sequence_count: 0,
      });
    }),
  );
});
