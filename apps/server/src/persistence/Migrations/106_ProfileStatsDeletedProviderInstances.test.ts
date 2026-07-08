// FILE: 106_ProfileStatsDeletedProviderInstances.test.ts
// Purpose: Verifies archived usage retains an instance id after upgrade.
// Layer: Persistence migration test.

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("106_ProfileStatsDeletedProviderInstances", (it) => {
  it.effect("backfills archived providers as the best available legacy instance ids", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 105 });
      yield* sql`
        INSERT INTO profile_stats_deleted_turns
          (thread_id, provider, model, reasoning, turn_count)
        VALUES ('thread-legacy-archive', 'codex', 'gpt-5-codex', NULL, 1)
      `;
      yield* sql`
        INSERT INTO profile_stats_deleted_tokens
          (thread_id, created_at, provider, model, tokens)
        VALUES (
          'thread-legacy-archive',
          '2026-07-08T10:00:00.000Z',
          'codex',
          'gpt-5-codex',
          1200
        )
      `;

      yield* runMigrations();

      const turnRows = yield* sql<{ readonly providerInstanceId: string | null }>`
        SELECT provider_instance_id AS providerInstanceId
        FROM profile_stats_deleted_turns
        WHERE thread_id = 'thread-legacy-archive'
      `;
      const tokenRows = yield* sql<{ readonly providerInstanceId: string | null }>`
        SELECT provider_instance_id AS providerInstanceId
        FROM profile_stats_deleted_tokens
        WHERE thread_id = 'thread-legacy-archive'
      `;
      assert.deepStrictEqual(turnRows, [{ providerInstanceId: "codex" }]);
      assert.deepStrictEqual(tokenRows, [{ providerInstanceId: "codex" }]);
    }),
  );
});
