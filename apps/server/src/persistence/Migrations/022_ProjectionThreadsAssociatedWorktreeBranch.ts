/**
 * Tracks the durable associated worktree branch for threads so handoff can
 * recreate or reattach the same workspace branch when possible.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN associated_worktree_branch TEXT
  `.pipe(Effect.catchTag("SqlError", () => Effect.void));

  yield* sql`
    UPDATE projection_threads
    SET associated_worktree_branch = branch
    WHERE associated_worktree_branch IS NULL
  `;
});
