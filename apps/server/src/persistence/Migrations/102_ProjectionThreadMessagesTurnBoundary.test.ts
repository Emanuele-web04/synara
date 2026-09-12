import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./102_ProjectionThreadMessagesTurnBoundary.ts";

it.layer(NodeSqliteClient.layerMemory())("message turn-boundary migration", (it) => {
  it.effect("adds an idempotent nullable starts_new_turn column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 101 });
      yield* sql`
        INSERT INTO projection_thread_messages (
          thread_id, message_id, role, text, is_streaming, source, created_at, updated_at
        ) VALUES (
          'thread-1', 'message-1', 'user', 'legacy steer', 0, 'native',
          '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'
        )
      `;

      yield* runMigrations();
      yield* migration;

      assert.deepStrictEqual(
        yield* sql`
          SELECT starts_new_turn
          FROM projection_thread_messages
          WHERE thread_id = 'thread-1' AND message_id = 'message-1'
        `,
        [{ starts_new_turn: null }],
      );
    }),
  );
});
