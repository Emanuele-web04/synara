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

describe("040_ProjectionThreadsPinnedMessagesNotes", () => {
  it.effect("adds pinned message and note columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 39 });

      const beforeColumns = yield* projectionThreadsColumnNames(sql);
      assert.notInclude(beforeColumns, "pinned_messages_json");
      assert.notInclude(beforeColumns, "notes");

      yield* runMigrations({ toMigrationInclusive: 40 });

      const afterColumns = yield* projectionThreadsColumnNames(sql);
      assert.include(afterColumns, "pinned_messages_json");
      assert.include(afterColumns, "notes");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("fills in the second column when the first already exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 39 });
      yield* sql`
        ALTER TABLE projection_threads
        ADD COLUMN pinned_messages_json TEXT
      `;

      yield* runMigrations({ toMigrationInclusive: 40 });

      const columns = yield* projectionThreadsColumnNames(sql);
      assert.include(columns, "pinned_messages_json");
      assert.include(columns, "notes");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
