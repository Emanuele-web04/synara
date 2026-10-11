import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Older session projections cleared latest_turn_id when a provider became
  // idle. Recover those claims from actual turn history; a ready session alone
  // cannot prove completion because it also occurs before the first turn.
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
          WHEN turns.state IN ('pending', 'running') THEN turns.state
          WHEN sessions.status = 'error' THEN 'error'
          WHEN sessions.status IN ('interrupted', 'stopped') THEN 'interrupted'
          WHEN EXISTS (
            SELECT 1
            FROM projection_turns AS pending_turns
            WHERE pending_turns.thread_id = threads.thread_id
              AND pending_turns.turn_id IS NULL
              AND pending_turns.state = 'pending'
              AND pending_turns.pending_message_id IS NOT NULL
              AND pending_turns.checkpoint_turn_count IS NULL
              AND (turns.requested_at IS NULL OR pending_turns.requested_at >= turns.requested_at)
          ) THEN 'pending'
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
         AND turns.turn_id = COALESCE(
           threads.latest_turn_id,
           (
             SELECT latest.turn_id
             FROM projection_turns AS latest
             WHERE latest.thread_id = threads.thread_id
               AND latest.turn_id IS NOT NULL
             ORDER BY latest.requested_at DESC, latest.turn_id DESC
             LIMIT 1
           )
         )
        WHERE threads.thread_id = tasks.thread_id
        LIMIT 1
      ), CASE
        WHEN tasks.status = 'failed' AND operations.status <> 'compensating' THEN 'completed'
        ELSE 'pending'
      END) IN ('pending', 'running')
  `;
});
