import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("075_ExternalMcpActiveCapacity", (it) => {
  it.effect("upgrades a database that already recorded the external MCP schema migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 74 });
      const before = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'view' AND name = 'external_mcp_active_capacity_claims'
      `;
      assert.deepStrictEqual(before, [{ count: 0 }]);

      yield* runMigrations({ toMigrationInclusive: 75 });
      const after = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'view' AND name = 'external_mcp_active_capacity_claims'
      `;
      assert.deepStrictEqual(after, [{ count: 1 }]);
    }),
  );
});
