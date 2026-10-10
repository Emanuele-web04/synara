/**
 * Profile-stats archive tables.
 *
 * When a thread is purged from the database (manual delete of an archived or
 * active thread), the aggregate numbers the Profile page needs are snapshotted
 * into these tables first. They are intentionally NOT `projection_*` tables:
 * projections can be reset and rebuilt from orchestration_events, while these
 * rows must survive both rebuilds and the purge of their source events.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One tombstone per purged thread; keeps totalThreads accurate.
  yield* sql`
    CREATE TABLE IF NOT EXISTS profile_stats_deleted_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT,
      deleted_at TEXT NOT NULL
    )
  `;

  // One row per native user prompt of a purged thread. Only the timestamp is
  // kept (no text), so day/hour bucketing stays exact for any client timezone.
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

  // Pre-aggregated turn counts per provider/model/reasoning of a purged thread.
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

  // Pre-aggregated skill/agent usage counts of a purged thread.
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

  // Token deltas of a purged thread, keyed by the original activity timestamp
  // so local-day bucketing stays exact for any client UTC offset (including
  // half-hour timezones).
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
