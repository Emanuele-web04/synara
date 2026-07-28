import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const orchestrationEventIndexNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'index'
      AND tbl_name = 'orchestration_events'
      AND name NOT LIKE 'sqlite_autoindex_%'
    ORDER BY name
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

layer("087_DropUnusedOrchestrationEventIndexes", (it) => {
  it.effect("drops the unused command/correlation indexes and keeps the load-bearing ones", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 86 });

      const before = yield* orchestrationEventIndexNames(sql);
      assert.include(before, "idx_orch_events_command_id");
      assert.include(before, "idx_orch_events_correlation_id");

      const executed = yield* runMigrations({ toMigrationInclusive: 87 });
      assert.deepStrictEqual(executed, [[87, "DropUnusedOrchestrationEventIndexes"]]);

      const after = yield* orchestrationEventIndexNames(sql);
      assert.notInclude(after, "idx_orch_events_command_id");
      assert.notInclude(after, "idx_orch_events_correlation_id");
      // The indexes that production reads actually depend on must survive.
      assert.include(after, "idx_orch_events_stream_version");
      assert.include(after, "idx_orch_events_stream_sequence");
      assert.include(after, "idx_orchestration_events_profile_turn_events");
    }),
  );

  it.effect("still writes and reads orchestration events after the indexes are gone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-1', 'thread', 'thread-1', 0, 'thread.created',
          '2026-07-25T10:00:00.000Z', 'command-1', NULL, 'correlation-1',
          'user', '{}', '{}'
        )
      `;

      const rows = yield* sql<{
        readonly commandId: string | null;
        readonly correlationId: string | null;
      }>`
        SELECT command_id AS "commandId", correlation_id AS "correlationId"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = 'thread-1'
      `;
      assert.deepStrictEqual(rows, [{ commandId: "command-1", correlationId: "correlation-1" }]);
    }),
  );

  it.effect("is a no-op when re-run against a database that already dropped them", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const executed = yield* runMigrations();
      assert.lengthOf(executed, 0);
    }),
  );
});
