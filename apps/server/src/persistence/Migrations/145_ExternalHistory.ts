import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Durable ledger for external provider history import/sync (Devin CLI/Desktop/Cloud,
// registered export files). Sources are canonical on (kind, scope_identity) so a
// reconnected origin/store reuses its identity; links are canonical on
// (source_id, external_session_id) so rescans never duplicate threads. Message rows
// key on the upstream identity; batches persist immutable normalized payloads keyed
// by a deterministic command_id so crash-retry replays are deduplicated by the
// existing engine receipt mechanism instead of inserting twice.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_history_sources (
      source_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      scope_identity TEXT NOT NULL,
      filters_json TEXT,
      decoder_version TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      paused INTEGER NOT NULL DEFAULT 0,
      credential_ref TEXT,
      scope_generation INTEGER NOT NULL DEFAULT 0,
      last_discovery_success_at TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(kind, scope_identity)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_history_links (
      link_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES external_history_sources(source_id),
      external_session_id TEXT NOT NULL,
      thread_id TEXT,
      source_revision TEXT,
      committed_message_cursor TEXT,
      history_status TEXT NOT NULL DEFAULT 'pending',
      native_resume_descriptor_json TEXT,
      upstream_metadata_json TEXT,
      user_override_flags_json TEXT,
      suppressed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source_id, external_session_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_external_history_links_thread
    ON external_history_links(thread_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_history_messages (
      link_id TEXT NOT NULL REFERENCES external_history_links(link_id),
      upstream_message_id TEXT NOT NULL,
      synara_message_id TEXT,
      source_order INTEGER NOT NULL,
      content_hash TEXT,
      source_revision TEXT,
      original_timestamp TEXT,
      visibility TEXT NOT NULL DEFAULT 'visible',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(link_id, upstream_message_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_history_jobs (
      job_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES external_history_sources(source_id),
      scope_generation INTEGER NOT NULL DEFAULT 0,
      scan_upper_bound TEXT,
      page_cursor TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      counters_json TEXT,
      retries INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at TEXT,
      checkpoint_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_external_history_jobs_source
    ON external_history_jobs(source_id, status)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_history_batches (
      batch_id TEXT PRIMARY KEY,
      job_id TEXT,
      link_id TEXT,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      command_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'persisted',
      accepted_sequence INTEGER,
      next_cursor TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_external_history_batches_link
    ON external_history_batches(link_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_external_history_batches_job
    ON external_history_batches(job_id)
  `;
});
