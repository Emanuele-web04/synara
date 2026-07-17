import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("059_ProviderSessionLifecycleGeneration", (it) => {
  it.effect("marks legacy bindings and persists a new opaque generation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at
        ) VALUES (
          'thread-legacy-generation',
          'codex',
          'codex',
          'full-access',
          'stopped',
          '2026-07-14T13:00:00.000Z'
        )
      `;

      yield* runMigrations();
      const legacy = yield* sql<{ readonly lifecycleGeneration: string }>`
        SELECT lifecycle_generation AS "lifecycleGeneration"
        FROM provider_session_runtime
        WHERE thread_id = 'thread-legacy-generation'
      `;
      assert.deepStrictEqual(legacy, [{ lifecycleGeneration: "legacy" }]);

      yield* sql`
        UPDATE provider_session_runtime
        SET lifecycle_generation = '7e19b5dd-ecaf-44c8-a748-c1e1d1660a6f'
        WHERE thread_id = 'thread-legacy-generation'
      `;
      const current = yield* sql<{ readonly lifecycleGeneration: string }>`
        SELECT lifecycle_generation AS "lifecycleGeneration"
        FROM provider_session_runtime
        WHERE thread_id = 'thread-legacy-generation'
      `;
      assert.deepStrictEqual(current, [
        { lifecycleGeneration: "7e19b5dd-ecaf-44c8-a748-c1e1d1660a6f" },
      ]);
    }),
  );
});
