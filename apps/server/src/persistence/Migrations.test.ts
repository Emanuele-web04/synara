import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const trackerRows = (sql: SqlClient.SqlClient) =>
  sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id ASC
  `;

const projectionThreadsColumnNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

layer("reconcileMigrationLineage", (it) => {
  // An imported database whose tracker high-water
  // mark is at or beyond Synara's latest migration ID. The migrator's max-ID
  // gate then skips every Synara migration — including the #032 self-heal —
  // and startup crashes on the missing env_mode column.
  it.effect("re-runs skipped migrations when an imported tracker outruns Synara's latest ID", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Bring the schema to the last shared migration.
      yield* runMigrations({ toMigrationInclusive: 16 });

      // Record a foreign lineage from 17 through past Synara's latest ID.
      const latestSynaraId = Math.max(...migrationEntries.map(([id]) => id));
      for (let id = 17; id <= latestSynaraId + 3; id++) {
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${id}, ${`ForeignMigration${id}`})
        `;
      }

      // The foreign lineage added some of the same columns, so the
      // re-run must tolerate columns that already exist.
      yield* sql`ALTER TABLE projection_threads ADD COLUMN archived_at TEXT`;

      const beforeColumns = yield* projectionThreadsColumnNames(sql);
      assert.notInclude(beforeColumns, "env_mode");

      const executed = yield* runMigrations();
      assert.deepStrictEqual(
        executed.map(([id]) => id),
        migrationEntries.map(([id]) => id).filter((id) => id >= 17),
      );

      const afterColumns = yield* projectionThreadsColumnNames(sql);
      assert.include(afterColumns, "env_mode");
      assert.include(afterColumns, "archived_at");

      // The tracker now mirrors the Synara lineage exactly; foreign rows are gone.
      const rows = yield* trackerRows(sql);
      assert.deepStrictEqual(
        rows.map((row) => [row.migration_id, row.name]),
        migrationEntries.map(([id, name]) => [id, name]),
      );
    }),
  );

  it.effect("leaves a healthy tracker alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      const executed = yield* runMigrations();
      assert.lengthOf(executed, 0);

      const rows = yield* trackerRows(sql);
      assert.deepStrictEqual(
        rows.map((row) => [row.migration_id, row.name]),
        migrationEntries.map(([id, name]) => [id, name]),
      );
    }),
  );

  it.effect("canonicalizes migration 32 when the preceding lineage is exact", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      yield* sql`
        UPDATE effect_sql_migrations
        SET name = 'PreviousMigration32Name'
        WHERE migration_id = 32
      `;

      const executed = yield* runMigrations();
      assert.lengthOf(executed, 0);
      const rows = yield* trackerRows(sql);
      assert.strictEqual(
        rows.find((row) => row.migration_id === 32)?.name,
        "ReconcileImportedSchemaLineage",
      );
    }),
  );

  it.effect("preserves tracker rows written by a newer Synara build", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      const futureId = Math.max(...migrationEntries.map(([id]) => id)) + 1;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${futureId}, 'FutureSynaraMigration')
      `;

      const executed = yield* runMigrations();
      assert.lengthOf(executed, 0);

      const rows = yield* trackerRows(sql);
      assert.deepStrictEqual(rows[rows.length - 1], {
        migration_id: futureId,
        name: "FutureSynaraMigration",
      });
    }),
  );

  it.effect("refuses to run when the divergence is inside the shared lineage prefix", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      yield* sql`
        UPDATE effect_sql_migrations
        SET name = 'NotAKnownLineage'
        WHERE migration_id = 5
      `;
      const rowsBefore = yield* trackerRows(sql);

      const error = yield* Effect.flip(runMigrations());
      assert.strictEqual(error._tag, "MigrationLineageError");

      // Nothing was deleted on the unrecognized database.
      const rowsAfter = yield* trackerRows(sql);
      assert.deepStrictEqual(rowsAfter, rowsBefore);
    }),
  );
});
