import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS review_pull_requests (
      repository_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      state TEXT NOT NULL,
      is_draft INTEGER NOT NULL,
      review_decision TEXT,
      checks_status TEXT NOT NULL,
      lane TEXT NOT NULL,
      author TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      head_branch TEXT NOT NULL,
      head_selector TEXT,
      updated_at TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      additions INTEGER NOT NULL,
      deletions INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      token_identity TEXT NOT NULL,
      synced_at INTEGER NOT NULL,
      tombstoned_at INTEGER,
      PRIMARY KEY (repository_id, number)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS review_pull_request_labels (
      repository_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      label TEXT NOT NULL,
      PRIMARY KEY (repository_id, number, label)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS review_pull_request_assignees (
      repository_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      login TEXT NOT NULL,
      PRIMARY KEY (repository_id, number, login)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS review_sync_state (
      repository_id TEXT PRIMARY KEY,
      token_identity TEXT NOT NULL,
      last_seen_updated_at TEXT,
      last_synced_at INTEGER,
      full_resynced_at INTEGER,
      last_graphql_cost INTEGER,
      points_remaining INTEGER,
      rate_reset_at INTEGER
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_review_pull_requests_state
    ON review_pull_requests(repository_id, state)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_review_pull_requests_lane
    ON review_pull_requests(repository_id, lane, updated_at_ms DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_review_pull_requests_updated
    ON review_pull_requests(repository_id, updated_at_ms DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_review_pull_requests_author
    ON review_pull_requests(repository_id, author)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_review_pull_requests_token
    ON review_pull_requests(token_identity)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_review_pull_request_labels_label
    ON review_pull_request_labels(repository_id, label)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_review_pull_request_assignees_login
    ON review_pull_request_assignees(repository_id, login)
  `;
});
