/**
 * Allow distinct gateway requests in the same turn while preserving every
 * operation ID and receipt used by worktree recovery and completion delivery.
 */
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('agent_gateway_operations')`;
  if (columns.some(({ name }) => name === "resume_context_json")) return;

  yield* sql`
    CREATE TABLE agent_gateway_operations_v146 (
      operation_id TEXT PRIMARY KEY,
      caller_thread_id TEXT NOT NULL,
      caller_turn_id TEXT NOT NULL,
      operation_kind TEXT NOT NULL CHECK (operation_kind IN ('create_threads')),
      request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 256),
      fingerprint TEXT NOT NULL,
      requested_count INTEGER NOT NULL CHECK (requested_count BETWEEN 1 AND 20),
      plan_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('reserved', 'dispatching', 'completed', 'failed', 'compensating')
      ),
      result_json TEXT,
      error_json TEXT,
      caller_purged_at TEXT,
      resume_context_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (caller_thread_id, caller_turn_id, operation_kind, request_id)
    )
  `;
  yield* sql`
    INSERT INTO agent_gateway_operations_v146 (
      operation_id, caller_thread_id, caller_turn_id, operation_kind, request_id,
      fingerprint, requested_count, plan_json, status, result_json, error_json,
      caller_purged_at, created_at, updated_at
    )
    SELECT
      operation_id, caller_thread_id, caller_turn_id, operation_kind, request_id,
      fingerprint, requested_count, plan_json, status, result_json, error_json,
      caller_purged_at, created_at, updated_at
    FROM agent_gateway_operations
  `;
  yield* sql`DROP TABLE agent_gateway_operations`;
  yield* sql`ALTER TABLE agent_gateway_operations_v146 RENAME TO agent_gateway_operations`;
  yield* sql`
    CREATE INDEX idx_agent_gateway_operations_status
    ON agent_gateway_operations (status, updated_at)
  `;
  yield* sql`
    CREATE INDEX idx_agent_gateway_operations_resume
    ON agent_gateway_operations (status, operation_id, created_at)
    WHERE resume_context_json IS NOT NULL AND status = 'completed'
  `;
});
