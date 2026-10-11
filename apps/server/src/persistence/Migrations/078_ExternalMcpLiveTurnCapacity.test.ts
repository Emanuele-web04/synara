import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("078_ExternalMcpLiveTurnCapacity", (it) => {
  it.effect("keeps a live turn active across a session error after upgrading from 77", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 77 });
      yield* sql`
        INSERT INTO external_mcp_integrations (
          integration_id, name, client_kind, audience, capabilities_json,
          created_at, expires_at, rate_limit_per_minute, concurrency_limit
        ) VALUES (
          'integration-migration-78', 'Migration 78', 'other', 'synara.external-mcp',
          '[]', '2026-07-21T00:00:00.000Z', '2027-07-21T00:00:00.000Z', 60, 1
        )
      `;
      yield* sql`
        INSERT INTO external_mcp_operations (
          operation_id, integration_id, request_id, fingerprint, requested_count,
          plan_json, status, created_at, updated_at
        ) VALUES (
          'operation-migration-78', 'integration-migration-78', 'request-migration-78',
          'fingerprint-migration-78', 1, '[]', 'completed',
          '2026-07-21T00:00:00.000Z', '2026-07-21T00:01:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO external_mcp_tasks (
          integration_id, operation_id, request_id, thread_id, project_id,
          status, created_at, updated_at
        ) VALUES (
          'integration-migration-78', 'operation-migration-78', 'request-migration-78',
          'thread-migration-78', 'project-migration-78', 'created',
          '2026-07-21T00:00:00.000Z', '2026-07-21T00:01:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, latest_turn_id,
          created_at, updated_at
        ) VALUES (
          'thread-migration-78', 'project-migration-78', 'Migration 78 task',
          '{"provider":"codex","model":"gpt-5.5"}', 'turn-migration-78',
          '2026-07-21T00:00:00.000Z', '2026-07-21T00:01:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, active_turn_id, last_error, updated_at
        ) VALUES (
          'thread-migration-78', 'error', 'codex', NULL, 'Later startup failed.',
          '2026-07-21T00:01:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, started_at,
          checkpoint_files_json
        ) VALUES (
          'thread-migration-78', 'turn-migration-78', 'running',
          '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:01.000Z', '[]'
        )
      `;
      const count = () => sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM external_mcp_active_capacity_claims
      `;
      assert.deepStrictEqual(yield* count(), [{ count: 0 }]);
      yield* runMigrations({ toMigrationInclusive: 78 });
      assert.deepStrictEqual(yield* count(), [{ count: 1 }]);
    }),
  );
});
