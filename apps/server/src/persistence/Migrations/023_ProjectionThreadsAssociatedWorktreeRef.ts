/**
 * Stores a durable worktree ref so detached worktrees can be materialized
 * again even when no branch name is available.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Some legacy desktop databases already recorded unrelated 17-22 migration ids,
  // so 023 must rebuild the missing thread/message metadata columns before it can finish.
  const projectionThreadsColumnExists = (columnName: string) =>
    sql<{ readonly exists: number }>`
      SELECT EXISTS(
        SELECT 1
        FROM pragma_table_info('projection_threads')
        WHERE name = ${columnName}
      ) AS "exists"
    `.pipe(Effect.map(([row]) => row?.exists === 1));

  const projectionThreadMessagesColumnExists = (columnName: string) =>
    sql<{ readonly exists: number }>`
      SELECT EXISTS(
        SELECT 1
        FROM pragma_table_info('projection_thread_messages')
        WHERE name = ${columnName}
      ) AS "exists"
    `.pipe(Effect.map(([row]) => row?.exists === 1));

  const ensureProjectionThreadsColumn = (columnName: string, definition: string) =>
    Effect.gen(function* () {
      if (yield* projectionThreadsColumnExists(columnName)) {
        return false;
      }
      yield* sql.unsafe(`
        ALTER TABLE projection_threads
        ADD COLUMN ${definition}
      `);
      return true;
    });

  const ensureProjectionThreadMessagesColumn = (columnName: string, definition: string) =>
    Effect.gen(function* () {
      if (yield* projectionThreadMessagesColumnExists(columnName)) {
        return false;
      }
      yield* sql.unsafe(`
        ALTER TABLE projection_thread_messages
        ADD COLUMN ${definition}
      `);
      return true;
    });

  yield* ensureProjectionThreadsColumn("handoff_json", "handoff_json TEXT");
  yield* ensureProjectionThreadMessagesColumn("source", "source TEXT NOT NULL DEFAULT 'native'");
  yield* ensureProjectionThreadMessagesColumn("skills_json", "skills_json TEXT");
  yield* ensureProjectionThreadMessagesColumn("mentions_json", "mentions_json TEXT");

  const addedEnvMode = yield* ensureProjectionThreadsColumn(
    "env_mode",
    "env_mode TEXT NOT NULL DEFAULT 'local'",
  );
  if (addedEnvMode) {
    yield* sql`
      UPDATE projection_threads
      SET env_mode = CASE
        WHEN worktree_path IS NOT NULL THEN 'worktree'
        ELSE 'local'
      END
    `;
  }

  yield* ensureProjectionThreadsColumn("fork_source_thread_id", "fork_source_thread_id TEXT");

  const addedAssociatedWorktreePath = yield* ensureProjectionThreadsColumn(
    "associated_worktree_path",
    "associated_worktree_path TEXT",
  );
  if (addedAssociatedWorktreePath) {
    yield* sql`
      UPDATE projection_threads
      SET associated_worktree_path = worktree_path
      WHERE associated_worktree_path IS NULL
    `;
  }

  const addedAssociatedWorktreeBranch = yield* ensureProjectionThreadsColumn(
    "associated_worktree_branch",
    "associated_worktree_branch TEXT",
  );
  if (addedAssociatedWorktreeBranch) {
    yield* sql`
      UPDATE projection_threads
      SET associated_worktree_branch = branch
      WHERE associated_worktree_branch IS NULL
    `;
  }

  const addedAssociatedWorktreeRef = yield* ensureProjectionThreadsColumn(
    "associated_worktree_ref",
    "associated_worktree_ref TEXT",
  );
  if (addedAssociatedWorktreeRef) {
    yield* sql`
      UPDATE projection_threads
      SET associated_worktree_ref = COALESCE(associated_worktree_branch, branch)
      WHERE associated_worktree_ref IS NULL
        AND COALESCE(associated_worktree_branch, branch) IS NOT NULL
    `;
  }
});
