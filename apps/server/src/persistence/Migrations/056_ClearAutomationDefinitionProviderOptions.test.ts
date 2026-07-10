// FILE: 056_ClearAutomationDefinitionProviderOptions.test.ts
// Purpose: Verifies legacy automation launch snapshots are removed on upgrade.
// Layer: Persistence migration test.

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("056_ClearAutomationDefinitionProviderOptions", (it) => {
  it.effect("clears persisted launch options while preserving the selected instance", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* sql`
        INSERT INTO automation_definitions (
          automation_id,
          project_id,
          name,
          prompt,
          schedule_json,
          enabled,
          model_selection_json,
          provider_options_json,
          runtime_mode,
          interaction_mode,
          worktree_mode,
          mode,
          stop_on_error,
          minimum_interval_seconds,
          retry_policy_json,
          misfire_policy,
          acknowledged_risks_json,
          iteration_count,
          created_at,
          updated_at
        )
        VALUES (
          'automation-legacy-options',
          'project-legacy-options',
          'Legacy options',
          'Run safely',
          '{"type":"manual"}',
          1,
          '{"instanceId":"codex_work","model":"gpt-5-codex"}',
          '{"codex":{"environment":{"CODEX_SECRET":"must-be-removed"}}}',
          'approval-required',
          'default',
          'auto',
          'standalone',
          1,
          60,
          '{"type":"none"}',
          'coalesce',
          '[]',
          0,
          '2026-07-08T10:00:00.000Z',
          '2026-07-08T10:00:00.000Z'
        )
      `;

      yield* runMigrations();

      const rows = yield* sql<{
        readonly modelSelection: string;
        readonly providerOptions: string | null;
      }>`
        SELECT
          model_selection_json AS modelSelection,
          provider_options_json AS providerOptions
        FROM automation_definitions
        WHERE automation_id = 'automation-legacy-options'
      `;
      assert.deepStrictEqual(rows, [
        {
          modelSelection: '{"instanceId":"codex_work","model":"gpt-5-codex"}',
          providerOptions: null,
        },
      ]);
    }),
  );
});
