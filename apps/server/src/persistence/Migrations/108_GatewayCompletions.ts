import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // no cascading parent FK — deletion must leave an explicit unavailable result
  yield* sql`CREATE TABLE IF NOT EXISTS agent_gateway_completions (
    child_thread_id TEXT PRIMARY KEY,
    creator_thread_id TEXT NOT NULL,
    initial_message_id TEXT NOT NULL,
    result_json TEXT,
    delivery_state TEXT NOT NULL DEFAULT 'pending'
      CHECK (delivery_state IN ('pending', 'delivered', 'unavailable')),
    context_event_sequence INTEGER,
    context_consumed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_gateway_completions_delivery
    ON agent_gateway_completions(delivery_state, created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_gateway_completions_context
    ON agent_gateway_completions(creator_thread_id, context_consumed, context_event_sequence)`;
});
