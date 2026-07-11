// FILE: 057_ClearAutomationRunProviderOptions.test.ts
// Purpose: Verifies queued-run identities are migrated or stopped before snapshots are stripped.
// Layer: Persistence migration test.

import { assert, it } from "@effect/vitest";
import { AutomationRunId } from "@synara/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AutomationRepositoryLive } from "../Layers/AutomationRepository.ts";
import { AutomationRepository } from "../Services/AutomationRepository.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ClearAutomationRunProviderOptions from "./057_ClearAutomationRunProviderOptions.ts";

const layer = it.layer(
  AutomationRepositoryLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

layer("057_ClearAutomationRunProviderOptions", (it) => {
  it.effect("tombstones a legacy queued Codex account before removing launch options", () =>
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
          '{"provider":"codex","modelSelection":{"provider":"codex","model":"gpt-5-codex"},"providerOptions":{"codex":{"accountId":"work","environment":{"CODEX_SECRET":"must-be-removed"}}},"runtimeMode":"approval-required","interactionMode":"default","worktreeMode":"auto","allowedCapabilities":["send-turn"],"createdAt":"2026-07-08T10:00:00.000Z"}',
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
      assert.deepStrictEqual(rows, [
        { instanceId: "synara_unresolved_automation_codex", providerOptions: null },
      ]);
    }),
  );

  it.effect("interrupts ambiguous active runs but only scrubs completed history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* sql`
        INSERT INTO automation_definitions (
          automation_id, project_id, name, prompt, schedule_json, enabled,
          model_selection_json, runtime_mode, interaction_mode, worktree_mode, mode,
          stop_on_error, minimum_interval_seconds, retry_policy_json, misfire_policy,
          acknowledged_risks_json, iteration_count, created_at, updated_at
        ) VALUES (
          'automation-run-ambiguity', 'project-run-ambiguity', 'Run ambiguity', 'Run safely',
          '{"type":"manual"}', 0, '{"instanceId":"claudeAgent","model":"claude-opus-4-1"}',
          'approval-required', 'default', 'auto', 'standalone', 1, 60, '{"type":"none"}',
          'coalesce', '[]', 2, '2026-07-08T10:00:00.000Z', '2026-07-08T10:00:00.000Z'
        )
      `;
      const snapshot = JSON.stringify({
        provider: "claudeAgent",
        modelSelection: { provider: "claudeAgent", model: "claude-opus-4-1" },
        providerOptions: { claudeAgent: { homePath: "/tmp/claude-work" } },
        runtimeMode: "approval-required",
        interactionMode: "default",
        worktreeMode: "auto",
        allowedCapabilities: ["send-turn"],
        createdAt: "2026-07-08T10:00:00.000Z",
      });
      yield* sql`
        INSERT INTO automation_runs (
          run_id, automation_id, project_id, trigger_type, status, scheduled_for,
          claimed_by, lease_expires_at, permission_snapshot_json, created_at, updated_at
        ) VALUES
          (
            'run-ambiguous-active', 'automation-run-ambiguity', 'project-run-ambiguity',
            'scheduled', 'claimed', '2026-07-12T10:00:00.000Z', 'scheduler-1',
            '2026-07-12T10:05:00.000Z', ${snapshot},
            '2026-07-08T10:00:00.000Z', '2026-07-08T10:00:00.000Z'
          ),
          (
            'run-ambiguous-complete', 'automation-run-ambiguity', 'project-run-ambiguity',
            'manual', 'succeeded', '2026-07-08T10:00:00.000Z', NULL, NULL, ${snapshot},
            '2026-07-08T10:00:00.000Z', '2026-07-08T10:00:00.000Z'
          )
      `;

      yield* ClearAutomationRunProviderOptions;
      yield* ClearAutomationRunProviderOptions;

      const rows = yield* sql<{
        readonly runId: string;
        readonly status: string;
        readonly instanceId: string;
        readonly providerOptions: string | null;
        readonly claimedBy: string | null;
        readonly leaseExpiresAt: string | null;
      }>`
        SELECT run_id AS runId, status,
          json_extract(permission_snapshot_json, '$.modelSelection.instanceId') AS instanceId,
          json_extract(permission_snapshot_json, '$.providerOptions') AS providerOptions,
          claimed_by AS claimedBy, lease_expires_at AS leaseExpiresAt
        FROM automation_runs
        WHERE automation_id = 'automation-run-ambiguity'
        ORDER BY run_id ASC
      `;
      assert.deepStrictEqual(rows, [
        {
          runId: "run-ambiguous-active",
          status: "interrupted",
          instanceId: "synara_unresolved_automation_claudeAgent",
          providerOptions: null,
          claimedBy: null,
          leaseExpiresAt: null,
        },
        {
          runId: "run-ambiguous-complete",
          status: "succeeded",
          instanceId: "synara_unresolved_automation_claudeAgent",
          providerOptions: null,
          claimedBy: null,
          leaseExpiresAt: null,
        },
      ]);

      const repository = yield* AutomationRepository;
      const decoded = yield* repository.getRunById({
        id: AutomationRunId.makeUnsafe("run-ambiguous-complete"),
      });
      assert.isTrue(Option.isSome(decoded));
      if (Option.isSome(decoded)) {
        assert.strictEqual(
          decoded.value.permissionSnapshot.modelSelection.instanceId,
          "synara_unresolved_automation_claudeAgent",
        );
        assert.isUndefined(decoded.value.permissionSnapshot.providerOptions);
      }
    }),
  );

  it.effect("replaces malformed snapshots with decodable redacted tombstones idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* sql`
        INSERT INTO automation_definitions (
          automation_id, project_id, name, prompt, schedule_json, enabled,
          model_selection_json, runtime_mode, interaction_mode, worktree_mode, mode,
          stop_on_error, minimum_interval_seconds, retry_policy_json, misfire_policy,
          acknowledged_risks_json, iteration_count, created_at, updated_at
        ) VALUES (
          'automation-malformed-run', 'project-malformed-run', 'Malformed run', 'Run safely',
          '{"type":"manual"}', 0, '{"instanceId":"codex","model":"gpt-5-codex"}',
          'approval-required', 'default', 'auto', 'standalone', 1, 60, '{"type":"none"}',
          'coalesce', '[]', 1, '2026-07-08T10:00:00.000Z', '2026-07-08T10:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO automation_runs (
          run_id, automation_id, project_id, trigger_type, status, scheduled_for,
          permission_snapshot_json, created_at, updated_at
        ) VALUES (
          'run-malformed-snapshot', 'automation-malformed-run', 'project-malformed-run',
          'scheduled', 'pending', '2026-07-12T10:00:00.000Z',
          '{"providerOptions":{"codex":{"environment":{"TOKEN":"secret"}}}',
          '2026-07-08T10:00:00.000Z', '2026-07-08T10:00:00.000Z'
        )
      `;

      yield* ClearAutomationRunProviderOptions;
      yield* ClearAutomationRunProviderOptions;

      const rows = yield* sql<{
        readonly status: string;
        readonly snapshot: string;
        readonly finishedAt: string | null;
      }>`
        SELECT status, permission_snapshot_json AS snapshot, finished_at AS finishedAt
        FROM automation_runs
        WHERE run_id = 'run-malformed-snapshot'
      `;
      assert.strictEqual(rows[0]?.status, "interrupted");
      assert.notInclude(rows[0]?.snapshot ?? "", "secret");
      assert.strictEqual(
        JSON.parse(rows[0]?.snapshot ?? "{}").modelSelection?.instanceId,
        "synara_unresolved_automation_codex",
      );
      assert.isNotNull(rows[0]?.finishedAt ?? null);

      const repository = yield* AutomationRepository;
      const decoded = yield* repository.getRunById({
        id: AutomationRunId.makeUnsafe("run-malformed-snapshot"),
      });
      assert.isTrue(Option.isSome(decoded));
      if (Option.isSome(decoded)) {
        assert.strictEqual(decoded.value.status, "interrupted");
        assert.strictEqual(
          decoded.value.permissionSnapshot.modelSelection.instanceId,
          "synara_unresolved_automation_codex",
        );
        assert.deepStrictEqual(decoded.value.permissionSnapshot.allowedCapabilities, []);
      }
      assert.deepStrictEqual(yield* repository.listRecoverableRuns({ limit: 10 }), []);
    }),
  );
});
