import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("060_PendingApprovalLifecycleGeneration", (it) => {
  it.effect("preserves legacy approvals and stores the emitting runtime generation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 59 });
      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id,
          thread_id,
          status,
          decision,
          created_at,
          resolved_at
        ) VALUES (
          'provider-request-legacy',
          'thread-generation',
          'pending',
          NULL,
          '2026-07-14T14:00:00.000Z',
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 60 });
      const legacy = yield* sql<{ readonly lifecycleGeneration: string | null }>`
        SELECT lifecycle_generation AS "lifecycleGeneration"
        FROM projection_pending_approvals
        WHERE thread_id = 'thread-generation'
          AND request_id = 'provider-request-legacy'
      `;
      assert.deepStrictEqual(legacy, [{ lifecycleGeneration: null }]);

      yield* sql`
        UPDATE projection_pending_approvals
        SET lifecycle_generation = 'generation-current'
        WHERE thread_id = 'thread-generation'
          AND request_id = 'provider-request-legacy'
      `;
      const current = yield* sql<{ readonly lifecycleGeneration: string | null }>`
        SELECT lifecycle_generation AS "lifecycleGeneration"
        FROM projection_pending_approvals
        WHERE thread_id = 'thread-generation'
          AND request_id = 'provider-request-legacy'
      `;
      assert.deepStrictEqual(current, [{ lifecycleGeneration: "generation-current" }]);
    }),
  );
});
