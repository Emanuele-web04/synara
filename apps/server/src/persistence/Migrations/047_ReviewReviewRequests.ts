import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS review_pull_request_review_requests (
      repository_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      login TEXT NOT NULL,
      PRIMARY KEY (repository_id, number, login)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_review_pull_request_review_requests_login
    ON review_pull_request_review_requests(repository_id, login)
  `;
});
