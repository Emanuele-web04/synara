import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly exists: number }>`
    SELECT EXISTS(
      SELECT 1 FROM pragma_table_info('external_mcp_integrations')
      WHERE name = 'client_kind'
    ) AS "exists"
  `;
  if (columns[0]?.exists !== 1) {
    yield* sql.unsafe(`
      ALTER TABLE external_mcp_integrations
      ADD COLUMN client_kind TEXT NOT NULL DEFAULT 'other'
      CHECK (client_kind IN ('codex', 'claudeCode', 'claudeDesktop', 'other'))
    `);
  }

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

  // Reinstall the capacity view for databases that ran an earlier development
  // version. Compensating operations are claims independently of task rows;
  // task registration can fail before compensation starts. Missing task
  // projections are conservatively active so projector lag cannot over-admit
  // work. Failed task rows remain active while durable compensation is
  // non-terminal or a projected turn is still live. The latest-turn join avoids
  // scanning/sorting checkpoint rows and makes checkpoint-only projections
  // incapable of masking live agent state.
  yield* sql`DROP VIEW IF EXISTS external_mcp_active_capacity_claims`;
  yield* sql`
    CREATE VIEW external_mcp_active_capacity_claims AS
    SELECT operations.integration_id, operations.operation_id
    FROM external_mcp_operations AS operations
    WHERE operations.status IN ('reserved', 'dispatching', 'compensating')

    UNION

    SELECT tasks.integration_id, tasks.operation_id
    FROM external_mcp_tasks AS tasks
    INNER JOIN external_mcp_operations AS operations
      ON operations.operation_id = tasks.operation_id
    WHERE tasks.status IN ('planned', 'created', 'failed')
      AND COALESCE((
        SELECT CASE
          WHEN sessions.status = 'error' THEN 'error'
          WHEN sessions.status IN ('interrupted', 'stopped') THEN 'interrupted'
          ELSE COALESCE(
            turns.state,
            CASE
              WHEN tasks.status = 'failed' AND operations.status <> 'compensating'
                THEN 'completed'
              ELSE 'pending'
            END
          )
        END
        FROM projection_threads AS threads
        LEFT JOIN projection_thread_sessions AS sessions
          ON sessions.thread_id = threads.thread_id
        LEFT JOIN projection_turns AS turns
          ON turns.thread_id = threads.thread_id
         AND turns.turn_id = threads.latest_turn_id
        WHERE threads.thread_id = tasks.thread_id
        LIMIT 1
      ), CASE
        WHEN tasks.status = 'failed' AND operations.status <> 'compensating' THEN 'completed'
        ELSE 'pending'
      END) IN ('pending', 'running')
  `;
});
