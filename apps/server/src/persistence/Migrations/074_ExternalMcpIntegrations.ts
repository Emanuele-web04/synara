import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_mcp_integrations (
      integration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
      audience TEXT NOT NULL CHECK (audience = 'synara.external-mcp'),
      client_kind TEXT NOT NULL CHECK (
        client_kind IN ('codex', 'claudeCode', 'claudeDesktop', 'other')
      ),
      credential_hash TEXT UNIQUE,
      capabilities_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_used_at TEXT,
      paired_at TEXT,
      revoked_at TEXT,
      rate_limit_per_minute INTEGER NOT NULL CHECK (rate_limit_per_minute BETWEEN 1 AND 10000),
      concurrency_limit INTEGER NOT NULL CHECK (concurrency_limit BETWEEN 1 AND 100)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_mcp_integration_projects (
      integration_id TEXT NOT NULL REFERENCES external_mcp_integrations(integration_id)
        ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      PRIMARY KEY (integration_id, project_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_mcp_pairing_codes (
      pairing_hash TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL UNIQUE REFERENCES external_mcp_integrations(integration_id)
        ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_mcp_operations (
      operation_id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL REFERENCES external_mcp_integrations(integration_id),
      request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 256),
      fingerprint TEXT NOT NULL,
      requested_count INTEGER NOT NULL CHECK (requested_count = 1),
      plan_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('reserved', 'dispatching', 'completed', 'failed', 'compensating')
      ),
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (integration_id, request_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_external_mcp_operations_status
    ON external_mcp_operations (status, updated_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_mcp_tasks (
      integration_id TEXT NOT NULL REFERENCES external_mcp_integrations(integration_id),
      operation_id TEXT NOT NULL UNIQUE REFERENCES external_mcp_operations(operation_id),
      request_id TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('planned', 'created', 'failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (integration_id, thread_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_external_mcp_tasks_project
    ON external_mcp_tasks (integration_id, project_id, status, updated_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_mcp_audit_log (
      audit_id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL REFERENCES external_mcp_integrations(integration_id),
      tool TEXT NOT NULL,
      request_id TEXT,
      project_id TEXT,
      runtime_mode TEXT,
      environment TEXT,
      outcome TEXT NOT NULL,
      created_task_ids_json TEXT NOT NULL DEFAULT '[]',
      detail TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_external_mcp_audit_rate
    ON external_mcp_audit_log (integration_id, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_mcp_rate_windows (
      integration_id TEXT PRIMARY KEY REFERENCES external_mcp_integrations(integration_id)
        ON DELETE CASCADE,
      window_id INTEGER NOT NULL,
      admitted_count INTEGER NOT NULL DEFAULT 0,
      rejected_count INTEGER NOT NULL DEFAULT 0,
      rejection_audit_id TEXT,
      updated_at TEXT NOT NULL
    )
  `;
});
