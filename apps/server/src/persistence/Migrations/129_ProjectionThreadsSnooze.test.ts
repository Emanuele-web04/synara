import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./129_ProjectionThreadsSnooze.ts";

it.effect(
  "adds nullable snooze fields without changing old rows or resetting saved deadlines on replay",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 126 });
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
    VALUES ('before-snooze', 'project', 'Keep this', '2026-10-02T10:00:00.000Z', '2026-10-02T10:00:00.000Z')`;
      yield* runMigrations({ toMigrationInclusive: 129 });
      const read = () =>
        sql<{
          title: string;
          deadline: string | null;
          reminder: string | null;
        }>`SELECT title, snoozed_until AS deadline, snooze_reminder_at AS reminder FROM projection_threads WHERE thread_id = 'before-snooze'`;
      assert.deepStrictEqual(yield* read(), [
        { title: "Keep this", deadline: null, reminder: null },
      ]);
      const deadline = "2026-10-02T11:00:00.000Z";
      yield* sql`UPDATE projection_threads SET snoozed_until = ${deadline} WHERE thread_id = 'before-snooze'`;
      yield* migration;
      assert.deepStrictEqual(yield* read(), [{ title: "Keep this", deadline, reminder: null }]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
