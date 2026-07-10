// FILE: 054_ProfileStatsDeletedTurnsProviderInstance.test.ts
// Purpose: Verifies archived profile turns retain an instance id after upgrade.
// Layer: Persistence migration test.

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("054_ProfileStatsDeletedTurnsProviderInstance", (it) => {
  it.effect("backfills the archived provider as the best available legacy instance id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO profile_stats_deleted_turns (
          thread_id,
          provider,
          model,
          reasoning,
          turn_count
        )
        VALUES ('thread-legacy-archive', 'work', 'claude-sonnet-4-6', 'high', 2)
      `;

      yield* runMigrations();

      const rows = yield* sql<{ readonly providerInstanceId: string | null }>`
        SELECT provider_instance_id AS providerInstanceId
        FROM profile_stats_deleted_turns
        WHERE thread_id = 'thread-legacy-archive'
      `;
      assert.deepStrictEqual(rows, [{ providerInstanceId: "work" }]);
    }),
  );
});
