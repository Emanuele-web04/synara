import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("063_ProjectionMessageCausalSequence", (it) => {
  it.effect("backfills a message from its first durable event sequence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* sql`
        INSERT INTO orchestration_events (
          sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
          payload_json, metadata_json
        ) VALUES (
          42, 'event-message-created', 'thread', 'thread-causal', 1, 'thread.message-sent',
          '2026-07-14T12:00:00.000Z', 'command-message-created', NULL,
          'command-message-created', 'system',
          '{"threadId":"thread-causal","messageId":"message-causal"}', '{}'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, source, created_at, updated_at
        ) VALUES (
          'message-causal', 'thread-causal', 'user', 'hello', 0, 'native',
          '2026-07-14T11:00:00.000Z', '2026-07-14T11:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 63 });
      const rows = yield* sql<{ readonly sequence: number | null }>`
        SELECT sequence
        FROM projection_thread_messages
        WHERE thread_id = 'thread-causal' AND message_id = 'message-causal'
      `;
      assert.deepStrictEqual(rows, [{ sequence: 42 }]);
    }),
  );
});
