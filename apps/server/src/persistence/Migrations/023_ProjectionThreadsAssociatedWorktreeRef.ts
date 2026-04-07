/**
 * Stores a durable worktree ref so detached worktrees can be materialized
 * again even when no branch name is available.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN associated_worktree_ref TEXT
  `.pipe(Effect.catchTag("SqlError", () => Effect.void));

  yield* sql`
    UPDATE projection_threads
    SET associated_worktree_ref = associated_worktree_branch
    WHERE associated_worktree_ref IS NULL
      AND associated_worktree_branch IS NOT NULL
  `;
});
