// Upgrade coverage: preserve source history and capture only recoverable usage.
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./103_ClaudeTokenAccounting.ts";

it.layer(NodeSqliteClient.layerMemory())("Claude accounting migration", (it) => {
  it.effect("preserves old snapshots and captures the last retained main-loop result once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 100 });
      yield* sql`
        INSERT INTO profile_stats_deleted_tokens (thread_id, created_at, provider, model, tokens)
        VALUES ('old', '2026-09-10', 'claudeAgent', 'claude-fable-5', 999999)
      `;
      for (const [id, provider, usage] of [
        ["first", "claudeAgent", { input_tokens: 1, output_tokens: 2 }],
        [
          "final",
          "claudeAgent",
          {
            input_tokens: 32,
            cache_creation_input_tokens: 419,
            cache_read_input_tokens: 26_816,
            output_tokens: 59,
          },
        ],
        ["other", "codex", { input_tokens: 999 }],
        ["missing", "claudeAgent", undefined],
      ] as const) {
        yield* sql`
          INSERT INTO provider_runtime_events
            (event_id, thread_id, turn_id, event_type, event_json, persisted_at)
          VALUES (${id}, 'root', ${id === "first" || id === "final" ? "turn" : id},
            'turn.completed', ${JSON.stringify({ provider, payload: { usage } })}, '2026-09-10')
        `;
      }
      const journal = yield* sql`SELECT * FROM provider_runtime_events`;
      yield* migration;
      yield* migration;
      assert.deepEqual(yield* sql`SELECT * FROM provider_runtime_events`, journal);
      assert.deepEqual(yield* sql`SELECT * FROM profile_stats_claude_legacy_usage`, [
        { thread_id: "root", turn_id: "turn", tokens: 27_326 },
      ]);
      assert.deepEqual(
        yield* sql`SELECT tokens, token_accounting_version FROM profile_stats_deleted_tokens`,
        [{ tokens: 999999, token_accounting_version: null }],
      );
    }),
  );
});
