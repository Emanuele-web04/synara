import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("058_ThreadScopedPendingApprovalIdentity", (it) => {
  it.effect("preserves legacy rows and permits the same request id in another thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id,
          thread_id,
          status,
          decision,
          created_at,
          resolved_at
        ) VALUES (
          'provider-request-1',
          'thread-a',
          'pending',
          NULL,
          '2026-07-14T12:00:00.000Z',
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id,
          thread_id,
          status,
          decision,
          created_at,
          resolved_at
        ) VALUES (
          'provider-request-1',
          'thread-b',
          'resolved',
          'accept',
          '2026-07-14T12:00:01.000Z',
          '2026-07-14T12:00:02.000Z'
        )
      `;

      const primaryKey = yield* sql<{ readonly name: string; readonly position: number }>`
        SELECT name, pk AS position
        FROM pragma_table_info('projection_pending_approvals')
        WHERE pk > 0
        ORDER BY pk ASC
      `;
      assert.deepStrictEqual(primaryKey, [
        { name: "thread_id", position: 1 },
        { name: "request_id", position: 2 },
      ]);
      const requestIdIndex = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM pragma_index_list('projection_pending_approvals')
        WHERE name = 'idx_projection_pending_approvals_request_id'
      `;
      assert.deepStrictEqual(requestIdIndex, [
        { name: "idx_projection_pending_approvals_request_id" },
      ]);

      const rows = yield* sql<{
        readonly threadId: string;
        readonly status: string;
        readonly decision: string | null;
      }>`
        SELECT thread_id AS "threadId", status, decision
        FROM projection_pending_approvals
        WHERE request_id = 'provider-request-1'
        ORDER BY thread_id ASC
      `;
      assert.deepStrictEqual(rows, [
        { threadId: "thread-a", status: "pending", decision: null },
        { threadId: "thread-b", status: "resolved", decision: "accept" },
      ]);
    }),
  );
});
