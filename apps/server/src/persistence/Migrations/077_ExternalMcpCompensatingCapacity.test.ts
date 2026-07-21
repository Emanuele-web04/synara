import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const freshLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

freshLayer("077_ExternalMcpCompensatingCapacity fresh install", (it) => {
  it.effect("installs compensating capacity claims on a fresh database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO external_mcp_integrations (
          integration_id, name, client_kind, audience, credential_hash,
          capabilities_json, created_at, expires_at, rate_limit_per_minute,
          concurrency_limit
        ) VALUES (
          'integration-migration-77-fresh', 'Migration 77 fresh', 'other',
          'synara.external-mcp', NULL, '[]', '2026-07-21T00:00:00.000Z',
          '2027-07-21T00:00:00.000Z', 60, 1
        )
      `;
      yield* sql`
        INSERT INTO external_mcp_operations (
          operation_id, integration_id, request_id, fingerprint, requested_count,
          plan_json, status, created_at, updated_at
        ) VALUES (
          'operation-migration-77-fresh', 'integration-migration-77-fresh',
          'request-migration-77-fresh', 'fingerprint-migration-77-fresh', 1, '[]',
          'compensating', '2026-07-21T00:00:00.000Z', '2026-07-21T00:01:00.000Z'
        )
      `;

      assert.deepStrictEqual(
        yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM external_mcp_active_capacity_claims
        `,
        [{ count: 1 }],
      );
    }),
  );
});

const upgradeLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

upgradeLayer("077_ExternalMcpCompensatingCapacity upgrade", (it) => {
  it.effect("restores compensating claims for databases that already ran migration 76", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });
      yield* sql`
        INSERT INTO external_mcp_integrations (
          integration_id, name, client_kind, audience, credential_hash,
          capabilities_json, created_at, expires_at, rate_limit_per_minute,
          concurrency_limit
        ) VALUES (
          'integration-migration-77', 'Migration 77', 'other', 'synara.external-mcp',
          NULL, '[]', '2026-07-21T00:00:00.000Z', '2027-07-21T00:00:00.000Z', 60, 1
        )
      `;
      yield* sql`
        INSERT INTO external_mcp_operations (
          operation_id, integration_id, request_id, fingerprint, requested_count,
          plan_json, status, created_at, updated_at
        ) VALUES (
          'operation-migration-77', 'integration-migration-77', 'request-migration-77',
          'fingerprint-migration-77', 1, '[]', 'compensating',
          '2026-07-21T00:00:00.000Z', '2026-07-21T00:01:00.000Z'
        )
      `;

      // Recreate the pre-77 operation branch to model an already-migrated dev database.
      yield* sql`DROP VIEW external_mcp_active_capacity_claims`;
      yield* sql`
        CREATE VIEW external_mcp_active_capacity_claims AS
        SELECT integration_id, operation_id
        FROM external_mcp_operations
        WHERE status IN ('reserved', 'dispatching')
      `;
      assert.deepStrictEqual(
        yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM external_mcp_active_capacity_claims
        `,
        [{ count: 0 }],
      );

      yield* runMigrations({ toMigrationInclusive: 77 });
      assert.deepStrictEqual(
        yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM external_mcp_active_capacity_claims
        `,
        [{ count: 1 }],
      );
    }),
  );
});
