// FILE: 052_ProjectionThreadsQueuedTurns.test.ts
// Purpose: Verifies additive and idempotent queued-turn projection migration behavior.
// Depends on: in-memory SQLite and the canonical migration loader.

import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const projectionThreadsColumnNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

describe("052_ProjectionThreadsQueuedTurns", () => {
  it.effect("adds the queued_turns_json column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 51 });

      const beforeColumns = yield* projectionThreadsColumnNames(sql);
      assert.notInclude(beforeColumns, "queued_turns_json");

      yield* runMigrations({ toMigrationInclusive: 52 });

      const afterColumns = yield* projectionThreadsColumnNames(sql);
      assert.include(afterColumns, "queued_turns_json");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("is a no-op when the column already exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 51 });
      yield* sql`
        ALTER TABLE projection_threads
        ADD COLUMN queued_turns_json TEXT
      `;

      yield* runMigrations({ toMigrationInclusive: 52 });

      const columns = yield* projectionThreadsColumnNames(sql);
      assert.include(columns, "queued_turns_json");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
