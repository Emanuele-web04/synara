/**
 * Verifies that a pre-orchestration gateway ledger survives both migrations and schema replay,
 * including unfinished cleanup and a completed request's durable receipt.
 */
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./146_AgentGatewayOperationWaves.ts";

it.effect("preserves existing operation rows and accepts distinct requests in the same turn", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 144 });
    yield* sql`
      INSERT INTO agent_gateway_operations (
        operation_id, caller_thread_id, caller_turn_id, operation_kind, request_id,
        fingerprint, requested_count, plan_json, status, result_json, error_json,
        caller_purged_at, created_at, updated_at
      ) VALUES
        ('completed', 'parent', 'first', 'create_threads', 'r1', 'f1', 1, '[]',
          'completed', '{"receipt":true}', NULL, NULL, 'first-created', 'first-updated'),
        ('cleanup', 'deleted', 'second', 'create_threads', 'r2', 'f2', 2, '[]',
          'compensating', NULL, '{"cleanup":true}', 'purged', 'second-created', 'second-updated')
    `;
    const reads = sql`SELECT operation_id, caller_thread_id, caller_turn_id, operation_kind,
      request_id, fingerprint, requested_count, plan_json, status, result_json, error_json,
      caller_purged_at, created_at, updated_at
      FROM agent_gateway_operations ORDER BY operation_id`;
    const before = yield* reads;
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 145 }), [
      [145, "ProjectionThreadSessionSteering"],
    ]);
    assert.deepEqual(yield* runMigrations(), [[146, "AgentGatewayOperationWaves"]]);
    assert.deepEqual(yield* reads, before);
    assert.deepEqual(
      yield* sql`SELECT name FROM pragma_table_info('projection_thread_sessions')
        WHERE name = 'supports_native_turn_steering'`,
      [{ name: "supports_native_turn_steering" }],
    );
    yield* sql`
      INSERT INTO agent_gateway_operations (
        operation_id, caller_thread_id, caller_turn_id, operation_kind, request_id,
        fingerprint, requested_count, plan_json, status, resume_context_json, created_at, updated_at
      ) VALUES ('next', 'parent', 'first', 'create_threads', 'r3', 'f3', 1, '[]',
        'reserved', '{"provider":"codex"}', 'next-created', 'next-updated')
    `;
    const upgraded = yield* reads;
    assert.lengthOf(upgraded, 3);
    yield* migration;
    assert.deepEqual(yield* reads, upgraded);
    assert.deepEqual(
      yield* sql`SELECT resume_context_json FROM agent_gateway_operations WHERE operation_id = 'next'`,
      [{ resume_context_json: '{"provider":"codex"}' }],
    );
    assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
