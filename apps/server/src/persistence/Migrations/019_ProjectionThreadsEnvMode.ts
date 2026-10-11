/**
 * Adds durable thread environment intent to projected thread rows so
 * server-backed threads can stay in "worktree" mode before a worktree cwd exists.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN env_mode TEXT NOT NULL DEFAULT 'local'
  `.pipe(Effect.catchTag("SqlError", () => Effect.void));

  yield* sql`
    UPDATE projection_threads
    SET env_mode = CASE
      WHEN worktree_path IS NOT NULL THEN 'worktree'
      ELSE 'local'
    END
  `;
});
