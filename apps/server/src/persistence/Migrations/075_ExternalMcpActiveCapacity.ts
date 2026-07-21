import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Capacity is derived entirely from durable state so admission survives a
  // server restart and does not depend on an in-memory semaphore. A creation
  // saga owns one slot until dispatch fails or enters compensation. Once a task
  // is planned, missing thread/turn projections are treated as pending: projectors
  // may lag the committed creation result and must never briefly free capacity.
  // Failed task rows also retain capacity while compensation is non-terminal or
  // a projected turn is still live. UNION (rather than UNION ALL) prevents the
  // hand-off between durable operation and task records from consuming two slots.
  // Recreate the view if an unreleased development build installed an older
  // definition before migration 75 was registered.
  yield* sql`DROP VIEW IF EXISTS external_mcp_active_capacity_claims`;
  yield* sql`
    CREATE VIEW external_mcp_active_capacity_claims AS
    SELECT operations.integration_id, operations.operation_id
    FROM external_mcp_operations AS operations
    WHERE operations.status IN ('reserved', 'dispatching')

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
