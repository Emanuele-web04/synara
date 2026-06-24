import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TABLE IF EXISTS review_walkthroughs`;
  yield* sql`DROP TABLE IF EXISTS review_cache_pr_walkthrough`;

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

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_review_cache_pr_walkthrough_repo_ref_fetched
    ON review_cache_pr_walkthrough (repository_id, reference, fetched_at)
  `;
});
