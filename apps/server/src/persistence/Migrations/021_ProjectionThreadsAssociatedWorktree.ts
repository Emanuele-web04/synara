/**
 * Tracks the durable associated worktree path for threads so handoff can
 * return to the same workspace even after the thread is moved back to Local.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN associated_worktree_path TEXT
  `.pipe(Effect.catchTag("SqlError", () => Effect.void));

  yield* sql`
    UPDATE projection_threads
    SET associated_worktree_path = worktree_path
    WHERE associated_worktree_path IS NULL
  `;
});
