import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("061_PendingApprovalSettlementState", (it) => {
  it.effect("migrates resolved rows and persists one response owner", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id, thread_id, status, decision, created_at, resolved_at
        ) VALUES (
          'request-settled', 'thread-settled', 'resolved', 'accept',
          '2026-07-14T12:00:00.000Z', '2026-07-14T12:00:01.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 61 });
      const rows = yield* sql<{
        readonly status: string;
        readonly responseCommandId: string | null;
        readonly responseRequestedAt: string | null;
      }>`
        SELECT
          status,
          response_command_id AS "responseCommandId",
          response_requested_at AS "responseRequestedAt"
        FROM projection_pending_approvals
        WHERE thread_id = 'thread-settled' AND request_id = 'request-settled'
      `;
      assert.deepStrictEqual(rows, [
        { status: "confirmed", responseCommandId: null, responseRequestedAt: null },
      ]);
    }),
  );
});
