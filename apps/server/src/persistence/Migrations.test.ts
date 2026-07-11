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

const tableColumnNames = (sql: SqlClient.SqlClient, tableName: string) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info(${tableName})
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

const tableIndexNames = (sql: SqlClient.SqlClient, tableName: string) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_index_list(${tableName})
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

  it.effect("continues when provider instance columns were partially migrated", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 48 });
      const now = new Date().toISOString();
      yield* sql`
        ALTER TABLE projection_thread_sessions
        ADD COLUMN provider_instance_id TEXT
      `;
      yield* sql`
        ALTER TABLE provider_session_runtime
        ADD COLUMN provider_instance_id TEXT
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          env_mode,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-codex-work',
          'project-provider-instance',
          'Work Account Thread',
          ${JSON.stringify({ instanceId: "codex_work", model: "gpt-5.4" })},
          'full-access',
          'default',
          'local',
          ${now},
          ${now},
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_instance_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES
          (
            'thread-codex-work',
            'running',
            'codex',
            NULL,
            'full-access',
            NULL,
            NULL,
            ${now}
          ),
          (
            'thread-no-model-selection',
            'running',
            'codex',
            NULL,
            'full-access',
            NULL,
            NULL,
            ${now}
          )
      `;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES
          (
            'thread-codex-work',
            'codex',
            NULL,
            'codex',
            'full-access',
            'running',
            ${now},
            NULL,
            ${JSON.stringify({ modelSelection: { instanceId: "codex_bound", model: "gpt-5.4" } })}
          ),
          (
            'runtime-codex-work',
            'codex',
            NULL,
            'codex',
            'full-access',
            'running',
            ${now},
            NULL,
            ${JSON.stringify({ modelSelection: { instanceId: "codex_work", model: "gpt-5.4" } })}
          ),
          (
            'runtime-no-instance',
            'codex',
            NULL,
            'codex',
            'full-access',
            'running',
            ${now},
            NULL,
            ${JSON.stringify({})}
          )
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 54 });
      assert.deepStrictEqual(
        executed.map(([id]) => id),
        [49, 50, 51, 52, 53, 54],
      );

      const projectionSessionColumns = yield* tableColumnNames(sql, "projection_thread_sessions");
      const runtimeColumns = yield* tableColumnNames(sql, "provider_session_runtime");
      assert.include(projectionSessionColumns, "provider_instance_id");
      assert.include(runtimeColumns, "provider_instance_id");

      const projectionSessionIndexes = yield* tableIndexNames(sql, "projection_thread_sessions");
      const runtimeIndexes = yield* tableIndexNames(sql, "provider_session_runtime");
      assert.include(projectionSessionIndexes, "idx_projection_thread_sessions_provider_instance");
      assert.include(runtimeIndexes, "idx_provider_session_runtime_provider_instance");

      const projectionRows = yield* sql<{
        readonly threadId: string;
        readonly providerInstanceId: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          provider_instance_id AS "providerInstanceId"
        FROM projection_thread_sessions
        WHERE thread_id IN ('thread-codex-work', 'thread-no-model-selection')
        ORDER BY thread_id ASC
      `;
      assert.deepStrictEqual(projectionRows, [
        { threadId: "thread-codex-work", providerInstanceId: "codex_bound" },
        { threadId: "thread-no-model-selection", providerInstanceId: "codex" },
      ]);

      const runtimeRows = yield* sql<{
        readonly threadId: string;
        readonly providerInstanceId: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          provider_instance_id AS "providerInstanceId"
        FROM provider_session_runtime
        WHERE thread_id IN ('runtime-codex-work', 'runtime-no-instance', 'thread-codex-work')
        ORDER BY thread_id ASC
      `;
      assert.deepStrictEqual(runtimeRows, [
        { threadId: "runtime-codex-work", providerInstanceId: "codex_work" },
        { threadId: "runtime-no-instance", providerInstanceId: "codex" },
        { threadId: "thread-codex-work", providerInstanceId: "codex_bound" },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("backfills provider instances without parsing malformed legacy JSON", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* runMigrations({ toMigrationInclusive: 48 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          env_mode,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-malformed-runtime',
          'project-provider-instance',
          'Malformed Legacy Runtime',
          'not-json',
          'full-access',
          'default',
          'local',
          ${now},
          ${now},
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-malformed-runtime',
          'stopped',
          'codex',
          'full-access',
          NULL,
          NULL,
          ${now}
        )
      `;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES (
          'thread-malformed-runtime',
          'codex',
          'codex',
          'full-access',
          'stopped',
          ${now},
          NULL,
          'not-json'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 54 });

      const [projectionSession] = yield* sql<{
        readonly providerInstanceId: string | null;
      }>`
        SELECT provider_instance_id AS "providerInstanceId"
        FROM projection_thread_sessions
        WHERE thread_id = 'thread-malformed-runtime'
      `;
      const [runtime] = yield* sql<{
        readonly providerInstanceId: string | null;
        readonly runtimePayloadJson: string | null;
      }>`
        SELECT
          provider_instance_id AS "providerInstanceId",
          runtime_payload_json AS "runtimePayloadJson"
        FROM provider_session_runtime
        WHERE thread_id = 'thread-malformed-runtime'
      `;

      assert.deepStrictEqual(projectionSession, { providerInstanceId: "codex" });
      assert.deepStrictEqual(runtime, {
        providerInstanceId: "codex",
        runtimePayloadJson: "not-json",
      });
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
