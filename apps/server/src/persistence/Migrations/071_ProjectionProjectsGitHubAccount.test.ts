import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const columns = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`SELECT name FROM pragma_table_info('projection_projects')`.pipe(
    Effect.map((rows) => rows.map((row) => row.name)),
  );

layer("071_ProjectionProjectsGitHubAccount", (it) => {
  it.effect("adds nullable durable GitHub account state idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 70 });
      assert.notInclude(yield* columns(sql), "github_account_json");

      yield* runMigrations();
      yield* runMigrations();
      assert.include(yield* columns(sql), "github_account_json");
    }),
  );
});
