import { it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("133_ExternalMcpOptionalConcurrency", (it) => {
  it.effect("preserves existing limits, credentials and child rows while allowing no limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations({ toMigrationInclusive: 132 });
      yield* sql`
        INSERT INTO external_mcp_integrations (
          integration_id, name, client_kind, audience, credential_hash, capabilities_json,
          created_at, expires_at, rate_limit_per_minute, concurrency_limit
        ) VALUES (
          'preserved', 'Existing pairing', 'other', 'synara.external-mcp', 'credential-hash',
          '["projects:read"]', '2026-10-09T00:00:00.000Z', '2027-10-09T00:00:00.000Z', 60, 2
        )
      `;
      yield* sql`
        INSERT INTO external_mcp_integration_projects VALUES ('preserved', 'project-preserved')
      `;
      yield* sql`
        INSERT INTO external_mcp_pairing_codes VALUES (
          'pairing-hash', 'preserved', '2026-10-09T00:00:00.000Z', '2027-10-09T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO external_mcp_operations (
          operation_id, integration_id, request_id, fingerprint, requested_count,
          plan_json, status, created_at, updated_at
        ) VALUES (
          'operation-preserved', 'preserved', 'request-preserved', 'fingerprint', 1,
          '[]', 'reserved', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO external_mcp_tasks VALUES (
          'preserved', 'operation-preserved', 'request-preserved', 'thread-preserved',
          'project-preserved', 'planned', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO external_mcp_audit_log (
          audit_id, integration_id, tool, outcome, created_at
        ) VALUES ('audit-preserved', 'preserved', 'synara_create_task', 'started', '2026-10-09T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO external_mcp_rate_windows VALUES (
          'preserved', 1, 4, 0, NULL, '2026-10-09T00:00:00.000Z'
        )
      `;
      const tables = [
        "external_mcp_integrations",
        "external_mcp_integration_projects",
        "external_mcp_pairing_codes",
        "external_mcp_operations",
        "external_mcp_tasks",
        "external_mcp_audit_log",
        "external_mcp_rate_windows",
      ];
      const before = yield* Effect.forEach(tables, (table) => sql.unsafe(`SELECT * FROM ${table}`));
      yield* runMigrations({ toMigrationInclusive: 133 });
      const after = yield* Effect.forEach(tables, (table) => sql.unsafe(`SELECT * FROM ${table}`));
      expect(after).toEqual(before);
      expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
      yield* sql`UPDATE external_mcp_integrations SET concurrency_limit = NULL WHERE integration_id = 'preserved'`;
      expect(yield* sql`SELECT concurrency_limit FROM external_mcp_integrations`).toEqual([
        { concurrency_limit: null },
      ]);
      for (const invalid of [0, 101]) {
        expect(
          (yield* sql`UPDATE external_mcp_integrations SET concurrency_limit = ${invalid}`.pipe(
            Effect.exit,
          ))._tag,
        ).toBe("Failure");
      }
      expect(yield* runMigrations({ toMigrationInclusive: 133 })).toEqual([]);
    }),
  );
});
