import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const tableColumns = (sql: SqlClient.SqlClient, tableName: string) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info(${tableName})
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

layer("070_Spaces", (it) => {
  it.effect("adds custom-space storage and nullable project assignments", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 69 });

      assert.notInclude(yield* tableColumns(sql, "projection_projects"), "space_id");

      const executed = yield* runMigrations({ toMigrationInclusive: 70 });
      assert.deepStrictEqual(executed, [[70, "Spaces"]]);
      assert.include(yield* tableColumns(sql, "projection_projects"), "space_id");
      assert.deepStrictEqual(yield* tableColumns(sql, "projection_spaces"), [
        "space_id",
        "name",
        "icon",
        "sort_order",
        "created_at",
        "updated_at",
        "deleted_at",
      ]);
    }),
  );

  it.effect("can be applied repeatedly without changing the schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runMigrations();

      assert.include(yield* tableColumns(sql, "projection_projects"), "space_id");
      assert.include(yield* tableColumns(sql, "projection_spaces"), "space_id");
    }),
  );
});
