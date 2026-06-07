import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const projectionThreadsColumnNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

layer("038_ReconcileLegacySidechatSource", (it) => {
  it.effect("heals legacy DBs whose tracker skipped Synara migration 33", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (33, 'BackfillMissingLiveThreadProjects')
      `;
      yield* runMigrations({ toMigrationInclusive: 37 });

      const beforeColumns = yield* projectionThreadsColumnNames(sql);
      assert.notInclude(beforeColumns, "sidechat_source_thread_id");

      yield* runMigrations();

      const afterColumns = yield* projectionThreadsColumnNames(sql);
      assert.include(afterColumns, "sidechat_source_thread_id");
    }),
  );

  it.effect("is a no-op when sidechat source already exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      yield* runMigrations();

      const columns = yield* projectionThreadsColumnNames(sql);
      assert.include(columns, "sidechat_source_thread_id");
    }),
  );
});
