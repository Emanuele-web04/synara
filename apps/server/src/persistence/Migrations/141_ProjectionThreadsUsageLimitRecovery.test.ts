import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./141_ProjectionThreadsUsageLimitRecovery.ts";

it.effect(
  "keeps existing failures unarmed and preserves recovery/cancellation across migration replay",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 135 });
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
      VALUES ('existing-failure', 'project', 'Keep this', '2026-10-31T10:00:00.000Z', '2026-10-31T10:00:00.000Z')`;
      yield* runMigrations({ toMigrationInclusive: 141 });
      const read = () => sql<{
        title: string;
        recovery: string | null;
        source: string | null;
        cancelled: string | null;
        turn: string | null;
        reset: string | null;
      }>`
      SELECT title, usage_limit_recovery_json AS recovery, usage_limit_recovery_source_json AS source,
      usage_limit_recovery_cancelled_at AS cancelled, usage_limit_recovery_cancelled_turn_id AS turn,
      usage_limit_recovery_last_reset_at AS reset FROM projection_threads WHERE thread_id='existing-failure'`;
      assert.deepStrictEqual(yield* read(), [
        {
          title: "Keep this",
          recovery: null,
          source: null,
          cancelled: null,
          turn: null,
          reset: null,
        },
      ]);
      const recovery = JSON.stringify({ id: "episode-1" });
      const source = JSON.stringify({ turnId: "turn-1" });
      const deadline = "2026-10-31T11:00:00.000Z";
      yield* sql`UPDATE projection_threads SET usage_limit_recovery_json=${recovery}, usage_limit_recovery_source_json=${source},
      usage_limit_recovery_cancelled_at=${deadline},usage_limit_recovery_cancelled_turn_id='turn-1',usage_limit_recovery_last_reset_at=${deadline}`;
      yield* migration;
      assert.deepStrictEqual(yield* read(), [
        {
          title: "Keep this",
          recovery,
          source,
          cancelled: deadline,
          turn: "turn-1",
          reset: deadline,
        },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
