import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./100_MessageTextChunks.ts";

it.layer(NodeSqliteClient.layerMemory())("message chunk migration", (it) => {
  it.effect(
    "upgrades and replays without changing legacy bodies, segments or projection cursors",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 99 });
        yield* sql`INSERT INTO projection_thread_messages (thread_id, message_id, role, text, is_streaming, source, created_at, updated_at)
      VALUES ('legacy', 'message', 'assistant', 'old partial response', 1, 'native', '2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z')`;
        yield* sql`INSERT INTO message_text_segments (thread_id, message_id, sequence, started_at, ended_at, text)
      VALUES ('legacy', 'message', 42, '2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z', 'old partial response')`;
        const before = yield* sql`SELECT * FROM projection_state`;
        yield* runMigrations();
        yield* migration;
        assert.deepStrictEqual(
          yield* sql`SELECT text, text_event_sequence FROM projection_thread_messages WHERE thread_id = 'legacy'`,
          [{ text: "old partial response", text_event_sequence: 0 }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT text FROM message_text_segments WHERE thread_id = 'legacy'`,
          [{ text: "old partial response" }],
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM message_text_chunks`, []);
        assert.deepStrictEqual(yield* sql`SELECT * FROM projection_state`, before);
      }),
  );
});
