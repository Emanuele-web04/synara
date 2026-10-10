/** on thread purge the aggregates the Profile page needs are snapshotted here first — deliberately NOT projection_* tables: projections rebuild from events while these must survive rebuilds and the source events' purge */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // one tombstone per purged thread — keeps totalThreads accurate
  yield* sql`
    CREATE TABLE IF NOT EXISTS profile_stats_deleted_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT,
      deleted_at TEXT NOT NULL
    )
  `;

  // only the timestamp kept (no text) — day/hour bucketing stays exact for any client timezone
  yield* sql`
    CREATE TABLE IF NOT EXISTS profile_stats_deleted_prompts (
      thread_id TEXT NOT NULL,
      project_id TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_profile_stats_deleted_prompts_thread
    ON profile_stats_deleted_prompts(thread_id)
  `;

  // pre-aggregated turn counts per provider/model/reasoning
  yield* sql`
    CREATE TABLE IF NOT EXISTS profile_stats_deleted_turns (
      thread_id TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      reasoning TEXT,
      turn_count INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_profile_stats_deleted_turns_thread
    ON profile_stats_deleted_turns(thread_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS profile_stats_deleted_skills (
      thread_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      run_count INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_profile_stats_deleted_skills_thread
    ON profile_stats_deleted_skills(thread_id)
  `;

  // keyed by the original activity timestamp so local-day bucketing stays exact for any UTC offset
  yield* sql`
    CREATE TABLE IF NOT EXISTS profile_stats_deleted_tokens (
      thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      provider TEXT,
      tokens INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_profile_stats_deleted_tokens_thread
    ON profile_stats_deleted_tokens(thread_id)
  `;
});
