/** predecessor trackers record 17-31 under unrelated names so those migrations never run on imports, leaving env_mode missing; renumbered self-heals (#023, #032) lose the race whenever the foreign lineage ships more; reconcileMigrationLineage now repairs trackers before the migrator so this runs regardless; idempotent, no-op on fresh installs */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

import BackfillProjectionThreadShellSummary from "./027_BackfillProjectionThreadShellSummary.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

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

  const ensureProjectionProjectsColumn = (columnName: string, definition: string) =>
    Effect.gen(function* () {
      const exists = yield* sql<{ readonly exists: number }>`
        SELECT EXISTS(
          SELECT 1
          FROM pragma_table_info('projection_projects')
          WHERE name = ${columnName}
        ) AS "exists"
      `.pipe(Effect.map(([row]) => row?.exists === 1));

      if (exists) {
        return false;
      }

      yield* sql.unsafe(`
        ALTER TABLE projection_projects
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

  yield* ensureProjectionThreadsColumn("archived_at", "archived_at TEXT");
  yield* ensureProjectionThreadsColumn("parent_thread_id", "parent_thread_id TEXT");
  yield* ensureProjectionThreadsColumn("subagent_agent_id", "subagent_agent_id TEXT");
  yield* ensureProjectionThreadsColumn("subagent_nickname", "subagent_nickname TEXT");
  yield* ensureProjectionThreadsColumn("subagent_role", "subagent_role TEXT");
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_parent_thread_id
    ON projection_threads(parent_thread_id)
  `;

  const addedLatestUserMessageAt = yield* ensureProjectionThreadsColumn(
    "latest_user_message_at",
    "latest_user_message_at TEXT",
  );
  const addedPendingApprovalCount = yield* ensureProjectionThreadsColumn(
    "pending_approval_count",
    "pending_approval_count INTEGER NOT NULL DEFAULT 0",
  );
  const addedPendingUserInputCount = yield* ensureProjectionThreadsColumn(
    "pending_user_input_count",
    "pending_user_input_count INTEGER NOT NULL DEFAULT 0",
  );
  const addedHasActionableProposedPlan = yield* ensureProjectionThreadsColumn(
    "has_actionable_proposed_plan",
    "has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0",
  );
  if (
    addedLatestUserMessageAt ||
    addedPendingApprovalCount ||
    addedPendingUserInputCount ||
    addedHasActionableProposedPlan
  ) {
    yield* BackfillProjectionThreadShellSummary;
  }

  yield* ensureProjectionProjectsColumn("kind", "kind TEXT NOT NULL DEFAULT 'project'");
  yield* ensureProjectionThreadsColumn("last_known_pr_json", "last_known_pr_json TEXT");
  yield* ensureProjectionThreadMessagesColumn("dispatch_mode", "dispatch_mode TEXT");
  yield* ensureProjectionThreadsColumn(
    "create_branch_flow_completed",
    "create_branch_flow_completed INTEGER NOT NULL DEFAULT 0",
  );
});
