import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const LEGACY_TOKEN_IDENTITY = "gh-user-v2:unknown";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const tables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'review_cache_pr_walkthrough'
  `;

  if (tables.length === 0) {
    yield* sql`
      CREATE TABLE review_cache_pr_walkthrough (
        repository_id TEXT NOT NULL,
        reference TEXT NOT NULL,
        patch_signature TEXT NOT NULL,
        token_identity TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (repository_id, reference, patch_signature, token_identity)
      )
    `;
  } else {
    const columns = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM pragma_table_info('review_cache_pr_walkthrough')
    `;
    const hasTokenIdentity = columns.some((column) => column.name === "token_identity");

    if (!hasTokenIdentity) {
      yield* sql`DROP TABLE IF EXISTS review_cache_pr_walkthrough_next`;
      yield* sql`
        CREATE TABLE review_cache_pr_walkthrough_next (
          repository_id TEXT NOT NULL,
          reference TEXT NOT NULL,
          patch_signature TEXT NOT NULL,
          token_identity TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY (repository_id, reference, patch_signature, token_identity)
        )
      `;

      yield* sql`
        INSERT INTO review_cache_pr_walkthrough_next (
          repository_id,
          reference,
          patch_signature,
          token_identity,
          payload_json,
          fetched_at
        )
        SELECT
          repository_id,
          reference,
          patch_signature,
          ${LEGACY_TOKEN_IDENTITY},
          payload_json,
          fetched_at
        FROM review_cache_pr_walkthrough
      `;

      yield* sql`DROP TABLE review_cache_pr_walkthrough`;
      yield* sql`ALTER TABLE review_cache_pr_walkthrough_next RENAME TO review_cache_pr_walkthrough`;
    }
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_review_cache_pr_walkthrough_repo_ref_fetched
    ON review_cache_pr_walkthrough (repository_id, reference, fetched_at)
  `;
});
