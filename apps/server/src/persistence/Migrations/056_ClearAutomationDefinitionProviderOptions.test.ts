// FILE: 056_ClearAutomationDefinitionProviderOptions.test.ts
// Purpose: Verifies legacy automation identities are migrated or disabled before snapshots clear.
// Layer: Persistence migration test.

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ClearAutomationDefinitionProviderOptions from "./056_ClearAutomationDefinitionProviderOptions.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("056_ClearAutomationDefinitionProviderOptions", (it) => {
  it.effect("tombstones a well-formed legacy Codex account id before clearing options", () =>
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
          '{"provider":"codex","model":"gpt-5-codex","options":[{"id":"reasoningEffort","value":"high"}]}',
          '{"codex":{"accountId":"work"}}',
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
        readonly modelOptions: string | null;
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
          instanceId: "synara_unresolved_automation_codex",
          legacyProvider: null,
          modelOptions: null,
          providerOptions: null,
          enabled: 0,
        },
      ]);
    }),
  );

  it.effect("disables an ambiguous definition and interrupts its active run idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 56 });
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
        readonly instanceId: string;
        readonly providerOptions: string | null;
      }>`
        SELECT enabled, next_run_at AS nextRunAt,
          json_extract(model_selection_json, '$.instanceId') AS instanceId,
          provider_options_json AS providerOptions
        FROM automation_definitions
        WHERE automation_id = 'automation-ambiguous-account'
      `;
      assert.deepStrictEqual(definitions, [
        {
          enabled: 0,
          nextRunAt: null,
          instanceId: "synara_unresolved_automation_claudeAgent",
          providerOptions: null,
        },
      ]);

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

      yield* runMigrations({ toMigrationInclusive: 56 });
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

      yield* runMigrations({ toMigrationInclusive: 56 });
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
        readonly instanceId: string;
        readonly providerOptions: string | null;
      }>`
        SELECT enabled, next_run_at AS nextRunAt,
          json_extract(model_selection_json, '$.instanceId') AS instanceId,
          provider_options_json AS providerOptions
        FROM automation_definitions
        WHERE automation_id = 'automation-malformed-default'
      `;
      assert.deepStrictEqual(rows, [
        {
          enabled: 0,
          nextRunAt: null,
          instanceId: "synara_unresolved_automation_codex",
          providerOptions: null,
        },
      ]);
    }),
  );

  it.effect(
    "tombstones every explicitly present environment across provider and account identity migration branches",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations({ toMigrationInclusive: 56 });
        yield* sql`
        INSERT INTO automation_definitions (
          automation_id, project_id, name, prompt, schedule_json, enabled,
          model_selection_json, provider_options_json, runtime_mode, interaction_mode,
          worktree_mode, mode, stop_on_error, minimum_interval_seconds, retry_policy_json,
          misfire_policy, acknowledged_risks_json, iteration_count, created_at, updated_at
        ) VALUES
          (
            'automation-account-with-empty-environment', 'project-identity-shapes',
            'Account with empty environment', 'Run safely', '{"type":"manual"}', 1,
            '{"provider":"codex","model":"gpt-5-codex"}',
            '{"codex":{"accountId":"work","environment":{}}}',
            'approval-required', 'default', 'auto', 'standalone', 1, 60, '{"type":"none"}',
            'coalesce', '[]', 0, '2026-07-08T10:00:00.000Z', '2026-07-08T10:00:00.000Z'
          ),
          (
            'automation-account-with-environment', 'project-identity-shapes',
            'Account with environment', 'Run safely', '{"type":"manual"}', 1,
            '{"provider":"codex","model":"gpt-5-codex"}',
            '{"codex":{"accountId":"work","environment":{"CODEX_HOME":"/tmp/other-codex","OPENAI_API_KEY":"secret"}}}',
            'approval-required', 'default', 'auto', 'standalone', 1, 60, '{"type":"none"}',
            'coalesce', '[]', 0, '2026-07-08T10:00:00.000Z', '2026-07-08T10:00:00.000Z'
          ),
          (
            'automation-empty-account-id', 'project-identity-shapes', 'Empty account id',
            'Run safely', '{"type":"manual"}', 1,
            '{"provider":"codex","model":"gpt-5-codex"}',
            '{"codex":{"accountId":{}}}',
            'approval-required', 'default', 'auto', 'standalone', 1, 60, '{"type":"none"}',
            'coalesce', '[]', 0, '2026-07-08T10:00:00.000Z', '2026-07-08T10:00:00.000Z'
          ),
          (
            'automation-empty-home', 'project-identity-shapes', 'Empty home',
            'Run safely', '{"type":"manual"}', 1,
            '{"provider":"claudeAgent","model":"claude-opus-4-1"}',
            '{"claudeAgent":{"homePath":""}}',
            'approval-required', 'default', 'auto', 'standalone', 1, 60, '{"type":"none"}',
            'coalesce', '[]', 0, '2026-07-08T10:00:00.000Z', '2026-07-08T10:00:00.000Z'
          ),
          (
            'automation-empty-environment', 'project-identity-shapes', 'Empty environment',
            'Run safely', '{"type":"manual"}', 1,
            '{"provider":"claudeAgent","model":"claude-opus-4-1"}',
            '{"claudeAgent":{"environment":{}}}',
            'approval-required', 'default', 'auto', 'standalone', 1, 60, '{"type":"none"}',
            'coalesce', '[]', 0, '2026-07-08T10:00:00.000Z', '2026-07-08T10:00:00.000Z'
          ),
          (
            'automation-account-with-malformed-home', 'project-identity-shapes',
            'Account with malformed home', 'Run safely', '{"type":"manual"}', 1,
            '{"provider":"codex","model":"gpt-5-codex"}',
            '{"codex":{"accountId":"work","homePath":{}}}',
            'approval-required', 'default', 'auto', 'standalone', 1, 60, '{"type":"none"}',
            'coalesce', '[]', 0, '2026-07-08T10:00:00.000Z', '2026-07-08T10:00:00.000Z'
          )
      `;

        yield* ClearAutomationDefinitionProviderOptions;

        const rows = yield* sql<{
          readonly automationId: string;
          readonly enabled: number;
          readonly instanceId: string;
        }>`
        SELECT automation_id AS automationId, enabled,
          json_extract(model_selection_json, '$.instanceId') AS instanceId
        FROM automation_definitions
        WHERE project_id = 'project-identity-shapes'
        ORDER BY automation_id ASC
      `;
        assert.deepStrictEqual(rows, [
          {
            automationId: "automation-account-with-empty-environment",
            enabled: 0,
            instanceId: "synara_unresolved_automation_codex",
          },
          {
            automationId: "automation-account-with-environment",
            enabled: 0,
            instanceId: "synara_unresolved_automation_codex",
          },
          {
            automationId: "automation-account-with-malformed-home",
            enabled: 0,
            instanceId: "synara_unresolved_automation_codex",
          },
          {
            automationId: "automation-empty-account-id",
            enabled: 0,
            instanceId: "synara_unresolved_automation_codex",
          },
          {
            automationId: "automation-empty-environment",
            enabled: 0,
            instanceId: "synara_unresolved_automation_claudeAgent",
          },
          {
            automationId: "automation-empty-home",
            enabled: 0,
            instanceId: "synara_unresolved_automation_claudeAgent",
          },
        ]);
      }),
  );
});
