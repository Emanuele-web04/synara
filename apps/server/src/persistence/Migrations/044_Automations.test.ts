import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const tableNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'automation_%'
    ORDER BY name ASC
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

const indexNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name LIKE 'idx_automation_%'
    ORDER BY name ASC
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

layer("automation migration", (it) => {
  it.effect("registers automation policy migration in the Synara lineage", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(migrationEntries[migrationEntries.length - 1]?.slice(0, 2), [
        47,
        "AutomationCompletionPolicyVersion",
      ]);
    }),
  );

  it.effect("creates automation tables and scheduler indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();

      assert.deepStrictEqual(yield* tableNames(sql), [
        "automation_definitions",
        "automation_runs",
        "automation_scheduler_leases",
      ]);
      assert.includeMembers(yield* indexNames(sql), [
        "idx_automation_definitions_due",
        "idx_automation_runs_history",
        "idx_automation_runs_recovery",
        "idx_automation_runs_project",
        "idx_automation_runs_thread",
      ]);
      const policyColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('automation_definitions')
        WHERE name IN (
          'minimum_interval_seconds',
          'max_runtime_seconds',
          'retry_policy_json',
          'misfire_policy',
          'acknowledged_risks_json',
          'completion_policy_json',
          'completion_policy_version',
          'completion_policy_updated_at'
        )
      `;
      assert.strictEqual(policyColumns.length, 8);
    }),
  );
});
