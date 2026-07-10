// FILE: 057_ClearAutomationRunProviderOptions.test.ts
// Purpose: Verifies historical run snapshots are stripped of provider launch options.
// Layer: Persistence migration test.

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("057_ClearAutomationRunProviderOptions", (it) => {
  it.effect("removes launch options while preserving the run's selected instance", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* sql`
        INSERT INTO automation_definitions (
          automation_id,
          project_id,
          name,
          prompt,
          schedule_json,
          enabled,
          model_selection_json,
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
          'automation-legacy-run',
          'project-legacy-run',
          'Legacy run',
          'Run safely',
          '{"type":"manual"}',
          1,
          '{"instanceId":"codex_work","model":"gpt-5-codex"}',
          'approval-required',
          'default',
          'auto',
          'standalone',
          1,
          60,
          '{"type":"none"}',
          'coalesce',
          '[]',
          1,
          '2026-07-08T10:00:00.000Z',
          '2026-07-08T10:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO automation_runs (
          run_id,
          automation_id,
          project_id,
          trigger_type,
          status,
          scheduled_for,
          permission_snapshot_json,
          created_at,
          updated_at
        )
        VALUES (
          'run-legacy-options',
          'automation-legacy-run',
          'project-legacy-run',
          'manual',
          'succeeded',
          '2026-07-08T10:00:00.000Z',
          '{"provider":"codex","modelSelection":{"instanceId":"codex_work","model":"gpt-5-codex"},"providerOptions":{"codex":{"environment":{"CODEX_SECRET":"must-be-removed"}}},"runtimeMode":"approval-required","interactionMode":"default","worktreeMode":"auto","allowedCapabilities":["send-turn"],"createdAt":"2026-07-08T10:00:00.000Z"}',
          '2026-07-08T10:00:00.000Z',
          '2026-07-08T10:00:00.000Z'
        )
      `;

      yield* runMigrations();

      const rows = yield* sql<{
        readonly instanceId: string;
        readonly providerOptions: string | null;
      }>`
        SELECT
          json_extract(permission_snapshot_json, '$.modelSelection.instanceId') AS instanceId,
          json_extract(permission_snapshot_json, '$.providerOptions') AS providerOptions
        FROM automation_runs
        WHERE run_id = 'run-legacy-options'
      `;
      assert.deepStrictEqual(rows, [{ instanceId: "codex_work", providerOptions: null }]);
    }),
  );
});
