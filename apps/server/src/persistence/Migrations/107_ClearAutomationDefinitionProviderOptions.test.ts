// FILE: 107_ClearAutomationDefinitionProviderOptions.test.ts
// Purpose: Verifies legacy automation identities are migrated or disabled before snapshots clear.
// Layer: Persistence migration test.

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ClearAutomationDefinitionProviderOptions from "./107_ClearAutomationDefinitionProviderOptions.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("107_ClearAutomationDefinitionProviderOptions", (it) => {
  it.effect("maps a legacy Codex account id to its exact instance before clearing options", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 106 });
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
          '{"provider":"codex","model":"gpt-5-codex","options":[{"id":"reasoningEffort","value":"high"}]}',
          '{"codex":{"accountId":"work","homePath":"/tmp/codex-work","environment":{"CODEX_SECRET":"must-be-removed"}}}',
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
        readonly instanceId: string;
        readonly legacyProvider: string | null;
        readonly modelOptions: string;
        readonly providerOptions: string | null;
        readonly enabled: number;
      }>`
        SELECT
          json_extract(model_selection_json, '$.instanceId') AS instanceId,
          json_extract(model_selection_json, '$.provider') AS legacyProvider,
          json_extract(model_selection_json, '$.options') AS modelOptions,
          provider_options_json AS providerOptions,
          enabled
        FROM automation_definitions
        WHERE automation_id = 'automation-legacy-options'
      `;
      assert.deepStrictEqual(rows, [
        {
          instanceId: "codex_work",
          legacyProvider: null,
          modelOptions: '[{"id":"reasoningEffort","value":"high"}]',
          providerOptions: null,
          enabled: 1,
        },
      ]);
    }),
  );

  it.effect("disables an ambiguous definition and interrupts its active run idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 106 });
      yield* sql`
        INSERT INTO automation_definitions (
          automation_id, project_id, name, prompt, schedule_json, enabled, next_run_at,
          model_selection_json, provider_options_json, runtime_mode, interaction_mode,
          worktree_mode, mode, stop_on_error, minimum_interval_seconds, retry_policy_json,
          misfire_policy, acknowledged_risks_json, iteration_count, created_at, updated_at
        ) VALUES (
          'automation-ambiguous-account', 'project-ambiguous-account', 'Ambiguous account',
          'Run safely', '{"type":"manual"}', 1, '2026-07-12T10:00:00.000Z',
          '{"provider":"claudeAgent","model":"claude-opus-4-1"}',
          '{"claudeAgent":{"homePath":"/tmp/claude-work","environment":{"ANTHROPIC_API_KEY":"secret"}}}',
          'approval-required', 'default', 'auto', 'standalone', 1, 60, '{"type":"none"}',
          'coalesce', '[]', 0, '2026-07-08T10:00:00.000Z', '2026-07-08T10:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO automation_runs (
          run_id, automation_id, project_id, trigger_type, status, scheduled_for,
          claimed_by, lease_expires_at, permission_snapshot_json, created_at, updated_at
        ) VALUES (
          'run-ambiguous-account', 'automation-ambiguous-account', 'project-ambiguous-account',
          'scheduled', 'claimed', '2026-07-12T10:00:00.000Z', 'scheduler-1',
          '2026-07-12T10:05:00.000Z',
          '{"provider":"claudeAgent","modelSelection":{"provider":"claudeAgent","model":"claude-opus-4-1"},"providerOptions":{"claudeAgent":{"homePath":"/tmp/claude-work"}},"runtimeMode":"approval-required","interactionMode":"default","worktreeMode":"auto","allowedCapabilities":["send-turn"],"createdAt":"2026-07-08T10:00:00.000Z"}',
          '2026-07-08T10:00:00.000Z', '2026-07-08T10:00:00.000Z'
        )
      `;

      yield* ClearAutomationDefinitionProviderOptions;
      yield* ClearAutomationDefinitionProviderOptions;

      const definitions = yield* sql<{
        readonly enabled: number;
        readonly nextRunAt: string | null;
        readonly providerOptions: string | null;
      }>`
        SELECT enabled, next_run_at AS nextRunAt, provider_options_json AS providerOptions
        FROM automation_definitions
        WHERE automation_id = 'automation-ambiguous-account'
      `;
      assert.deepStrictEqual(definitions, [{ enabled: 0, nextRunAt: null, providerOptions: null }]);

      const runs = yield* sql<{
        readonly status: string;
        readonly claimedBy: string | null;
        readonly leaseExpiresAt: string | null;
        readonly finishedAt: string | null;
      }>`
        SELECT status, claimed_by AS claimedBy, lease_expires_at AS leaseExpiresAt,
          finished_at AS finishedAt
        FROM automation_runs
        WHERE run_id = 'run-ambiguous-account'
      `;
      assert.strictEqual(runs[0]?.status, "interrupted");
      assert.strictEqual(runs[0]?.claimedBy, null);
      assert.strictEqual(runs[0]?.leaseExpiresAt, null);
      assert.isNotNull(runs[0]?.finishedAt ?? null);
    }),
  );

  it.effect("keeps an explicit instance safe even when its obsolete options are malformed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 106 });
      yield* sql`
        INSERT INTO automation_definitions (
          automation_id, project_id, name, prompt, schedule_json, enabled,
          model_selection_json, provider_options_json, runtime_mode, interaction_mode,
          worktree_mode, mode, stop_on_error, minimum_interval_seconds, retry_policy_json,
          misfire_policy, acknowledged_risks_json, iteration_count, created_at, updated_at
        ) VALUES (
          'automation-explicit-instance', 'project-explicit-instance', 'Explicit instance',
          'Run safely', '{"type":"manual"}', 1,
          '{"instanceId":"work_profile","model":"custom-model"}', '{malformed',
          'approval-required', 'default', 'auto', 'standalone', 1, 60, '{"type":"none"}',
          'coalesce', '[]', 0, '2026-07-08T10:00:00.000Z', '2026-07-08T10:00:00.000Z'
        )
      `;

      yield* ClearAutomationDefinitionProviderOptions;

      const rows = yield* sql<{
        readonly enabled: number;
        readonly instanceId: string;
        readonly providerOptions: string | null;
      }>`
        SELECT enabled, json_extract(model_selection_json, '$.instanceId') AS instanceId,
          provider_options_json AS providerOptions
        FROM automation_definitions
        WHERE automation_id = 'automation-explicit-instance'
      `;
      assert.deepStrictEqual(rows, [
        { enabled: 1, instanceId: "work_profile", providerOptions: null },
      ]);
    }),
  );

  it.effect("disables a default-instance definition when its options JSON is malformed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 106 });
      yield* sql`
        INSERT INTO automation_definitions (
          automation_id, project_id, name, prompt, schedule_json, enabled, next_run_at,
          model_selection_json, provider_options_json, runtime_mode, interaction_mode,
          worktree_mode, mode, stop_on_error, minimum_interval_seconds, retry_policy_json,
          misfire_policy, acknowledged_risks_json, iteration_count, created_at, updated_at
        ) VALUES (
          'automation-malformed-default', 'project-malformed-default', 'Malformed default',
          'Run safely', '{"type":"manual"}', 1, '2026-07-12T10:00:00.000Z',
          '{"provider":"codex","model":"gpt-5-codex"}', '{malformed',
          'approval-required', 'default', 'auto', 'standalone', 1, 60, '{"type":"none"}',
          'coalesce', '[]', 0, '2026-07-08T10:00:00.000Z', '2026-07-08T10:00:00.000Z'
        )
      `;

      yield* ClearAutomationDefinitionProviderOptions;

      const rows = yield* sql<{
        readonly enabled: number;
        readonly nextRunAt: string | null;
        readonly providerOptions: string | null;
      }>`
        SELECT enabled, next_run_at AS nextRunAt, provider_options_json AS providerOptions
        FROM automation_definitions
        WHERE automation_id = 'automation-malformed-default'
      `;
      assert.deepStrictEqual(rows, [{ enabled: 0, nextRunAt: null, providerOptions: null }]);
    }),
  );
});
