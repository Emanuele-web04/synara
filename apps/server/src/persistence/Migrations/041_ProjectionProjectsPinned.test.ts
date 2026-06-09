import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const projectionProjectsColumnNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_projects')
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

layer("041_ProjectionProjectsPinned", (it) => {
  it.effect("adds durable project pin state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });

      const beforeColumns = yield* projectionProjectsColumnNames(sql);
      assert.notInclude(beforeColumns, "is_pinned");

      yield* runMigrations();

      const afterColumns = yield* projectionProjectsColumnNames(sql);
      assert.include(afterColumns, "is_pinned");
    }),
  );

  it.effect("is a no-op when project pin state already exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      yield* runMigrations();

      const columns = yield* projectionProjectsColumnNames(sql);
      assert.include(columns, "is_pinned");
    }),
  );
});
