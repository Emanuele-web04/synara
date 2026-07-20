import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Capacity is derived entirely from durable state so admission survives a
  // server restart and does not depend on an in-memory semaphore. A creation
  // saga owns one slot until it becomes terminal. After dispatch commits, its
  // external task keeps that same slot while the live thread's latest turn is
  // pending or running. UNION (rather than UNION ALL) prevents the hand-off
  // between those two durable records from briefly consuming two slots.
  // Recreate the view if an unreleased development build installed an older
  // definition before migration 75 was registered.
  yield* sql`DROP VIEW IF EXISTS external_mcp_active_capacity_claims`;
  yield* sql`
    CREATE VIEW external_mcp_active_capacity_claims AS
    SELECT operations.integration_id, operations.operation_id
    FROM external_mcp_operations AS operations
    WHERE operations.status IN ('reserved', 'dispatching', 'compensating')

    UNION

    SELECT tasks.integration_id, tasks.operation_id
    FROM external_mcp_tasks AS tasks
    WHERE tasks.status = 'planned'
       OR (
         tasks.status = 'created'
         AND COALESCE((
           SELECT COALESCE(turns.state, 'pending')
           FROM projection_threads AS threads
           LEFT JOIN projection_turns AS turns
             ON turns.thread_id = threads.thread_id
            AND turns.turn_id = threads.latest_turn_id
           WHERE threads.thread_id = tasks.thread_id
             AND threads.deleted_at IS NULL
           LIMIT 1
         ), 'completed') IN ('pending', 'running')
       )
  `;
});
