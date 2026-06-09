import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS review_cache_pr_list (
      repository_id TEXT NOT NULL,
      list_filter TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      etag TEXT,
      last_modified TEXT,
      fetched_at INTEGER NOT NULL,
      last_validated_at INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL,
      token_identity TEXT NOT NULL,
      head_sha TEXT,
      PRIMARY KEY (repository_id, list_filter)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS review_cache_pr_overview (
      repository_id TEXT NOT NULL,
      reference TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      etag TEXT,
      last_modified TEXT,
      fetched_at INTEGER NOT NULL,
      last_validated_at INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL,
      token_identity TEXT NOT NULL,
      head_sha TEXT,
      PRIMARY KEY (repository_id, reference)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS review_cache_pr_conversation (
      repository_id TEXT NOT NULL,
      reference TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      etag TEXT,
      last_modified TEXT,
      fetched_at INTEGER NOT NULL,
      last_validated_at INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL,
      token_identity TEXT NOT NULL,
      head_sha TEXT,
      PRIMARY KEY (repository_id, reference)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS review_cache_pr_diff (
      repository_id TEXT NOT NULL,
      reference TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      etag TEXT,
      last_modified TEXT,
      fetched_at INTEGER NOT NULL,
      last_validated_at INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL,
      token_identity TEXT NOT NULL,
      PRIMARY KEY (repository_id, reference, head_sha)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_review_cache_pr_list_token
    ON review_cache_pr_list(token_identity)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_review_cache_pr_overview_token
    ON review_cache_pr_overview(token_identity)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_review_cache_pr_conversation_token
    ON review_cache_pr_conversation(token_identity)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_review_cache_pr_diff_token
    ON review_cache_pr_diff(token_identity)
  `;
});
