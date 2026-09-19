import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./105_AsyncUserInput.ts";

it.layer(NodeSqliteClient.layerMemory())("asynchronous question migration", (it) => {
  it.effect("adds an idempotent nullable async_user_input_json column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 104 });
      yield* sql`
        INSERT INTO projection_thread_messages (
          thread_id, message_id, role, text, is_streaming, source, created_at, updated_at
        ) VALUES (
          'thread-1', 'message-1', 'user', 'legacy steer', 0, 'native',
          '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'
        )
      `;

      const review = '{"reviewId":"preserved-claude-review"}';
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, created_at, updated_at, claude_cache_review_json
        ) VALUES (
          'thread-claude', 'project-claude', 'Existing Claude chat',
          '{"provider":"claudeAgent","model":"claude-opus-4-6"}',
          '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z', ${review}
        )
      `;
      assert.deepStrictEqual(yield* runMigrations(), [[105, "AsyncUserInput"]]);
      assert.deepStrictEqual(
        yield* sql`
        SELECT claude_cache_review_json FROM projection_threads WHERE thread_id = 'thread-claude'
      `,
        [{ claude_cache_review_json: review }],
      );
      yield* migration;

      assert.deepStrictEqual(
        yield* sql`
          SELECT async_user_input_json
          FROM projection_thread_messages
          WHERE thread_id = 'thread-1' AND message_id = 'message-1'
        `,
        [{ async_user_input_json: null }],
      );
    }),
  );
});
