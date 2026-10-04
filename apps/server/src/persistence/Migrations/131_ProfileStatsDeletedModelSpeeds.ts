/**
 * Profile-stats archive for model speed.
 *
 * Purging a thread snapshots its measured turns here first (one row per turn:
 * timestamp, provider/instance/model, fast mode, output tokens, generation
 * time), so the Profile page's model speed history, bucketed by the viewer's
 * local day at query time, keeps every turn ever measured. Additive: a new
 * table nothing else reads, so an older app version ignores it.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS profile_stats_deleted_model_speeds (
      thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      provider TEXT,
      provider_instance_id TEXT,
      model TEXT,
      fast_mode INTEGER,
      output_tokens INTEGER NOT NULL,
      generation_ms INTEGER NOT NULL,
      turn_count INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_profile_stats_deleted_model_speeds_thread
    ON profile_stats_deleted_model_speeds(thread_id)
  `;
});
