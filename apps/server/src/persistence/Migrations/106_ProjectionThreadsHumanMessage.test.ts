import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./106_ProjectionThreadsHumanMessage.ts";

it.layer(NodeSqliteClient.layerMemory())("human-message summary migration", (it) => {
  it.effect(
    "backfills human and legacy sends without treating agent-only threads as human activity",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 105 });
        const at = (minute: number) => `2026-09-17T10:0${minute}:00.000Z`;
        for (const threadId of ["mixed", "legacy", "agent-only", "empty"]) {
          yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, created_at, updated_at,
            latest_user_message_at
          ) VALUES (${threadId}, 'project', ${threadId}, '{"provider":"codex","model":"gpt-5"}',
            ${at(0)}, ${at(5)}, ${at(5)})
        `;
        }
        for (const [index, [threadId, role, origin]] of [
          ["mixed", "user", "user"],
          ["legacy", "user", null],
          ["mixed", "user", "agent"],
          ["mixed", "user", "automation"],
          ["mixed", "assistant", null],
          ["agent-only", "user", "agent"],
        ].entries()) {
          yield* sql`
          INSERT INTO projection_thread_messages (
            thread_id, message_id, role, dispatch_origin, text, is_streaming, created_at, updated_at
          ) VALUES (${threadId}, ${`message-${index}`}, ${role}, ${origin}, '', 0, ${at(index)}, ${at(index)})
        `;
        }
        yield* sql`UPDATE projection_thread_messages SET updated_at = ${at(6)} WHERE message_id = 'message-0'`;
        yield* runMigrations({ toMigrationInclusive: 106 });
        assert.deepStrictEqual(
          yield* sql`
        SELECT thread_id, latest_human_message_at FROM projection_threads ORDER BY thread_id
      `,
          [
            { thread_id: "agent-only", latest_human_message_at: null },
            { thread_id: "empty", latest_human_message_at: null },
            { thread_id: "legacy", latest_human_message_at: at(1) },
            { thread_id: "mixed", latest_human_message_at: at(6) },
          ],
        );
        assert.deepStrictEqual(
          yield* sql`
        SELECT DISTINCT latest_user_message_at FROM projection_threads
      `,
          [{ latest_user_message_at: at(5) }],
        );
        yield* sql`UPDATE projection_threads SET latest_human_message_at = ${at(6)} WHERE thread_id = 'mixed'`;
        yield* migration;
        assert.deepStrictEqual(
          yield* sql`
        SELECT latest_human_message_at FROM projection_threads WHERE thread_id = 'mixed'
      `,
          [{ latest_human_message_at: at(6) }],
        );
      }),
  );
});
