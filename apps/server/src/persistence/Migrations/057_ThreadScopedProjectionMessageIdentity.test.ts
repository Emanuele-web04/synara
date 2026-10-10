import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("057_ThreadScopedProjectionMessageIdentity", (it) => {
  it.effect("preserves legacy rows and permits the same message id in another thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        ) VALUES (
          'provider-message-1',
          'thread-a',
          'assistant',
          'legacy row',
          0,
          '2026-07-14T10:00:00.000Z',
          '2026-07-14T10:00:00.000Z'
        )
      `;

      yield* runMigrations();
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        ) VALUES (
          'provider-message-1',
          'thread-b',
          'assistant',
          'second thread',
          0,
          '2026-07-14T10:00:01.000Z',
          '2026-07-14T10:00:01.000Z'
        )
      `;

      const primaryKey = yield* sql<{ readonly name: string; readonly position: number }>`
        SELECT name, pk AS position
        FROM pragma_table_info('projection_thread_messages')
        WHERE pk > 0
        ORDER BY pk ASC
      `;
      assert.deepStrictEqual(primaryKey, [
        { name: "thread_id", position: 1 },
        { name: "message_id", position: 2 },
      ]);
      const messageIdIndex = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM pragma_index_list('projection_thread_messages')
        WHERE name = 'idx_projection_thread_messages_message_id'
      `;
      assert.deepStrictEqual(messageIdIndex, [
        { name: "idx_projection_thread_messages_message_id" },
      ]);

      const rows = yield* sql<{ readonly threadId: string; readonly text: string }>`
        SELECT thread_id AS "threadId", text
        FROM projection_thread_messages
        WHERE message_id = 'provider-message-1'
        ORDER BY thread_id ASC
      `;
      assert.deepStrictEqual(rows, [
        { threadId: "thread-a", text: "legacy row" },
        { threadId: "thread-b", text: "second thread" },
      ]);
    }),
  );
});
