import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_worktree_workspaces (
      workspace_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      repository_identity TEXT,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      title TEXT NOT NULL,
      path TEXT,
      branch TEXT,
      head_ref TEXT,
      target_ref TEXT NOT NULL,
      target_resolved_commit TEXT,
      created_from_commit TEXT,
      source_kind TEXT NOT NULL,
      source_ref TEXT,
      setup_status TEXT NOT NULL,
      setup_error TEXT,
      setup_log_id TEXT,
      last_known_pr_json TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      lifecycle_generation INTEGER NOT NULL DEFAULT 0,
      active_operation_json TEXT,
      last_failure_json TEXT,
      mutation_revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      deleted_at TEXT
    )
  `;

  if (!(yield* columnExists(sql, "projection_threads", "workspace_id"))) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN workspace_id TEXT`;
  }
  if (!(yield* columnExists(sql, "projection_projects", "repository_identity"))) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN repository_identity TEXT`;
  }
  if (!(yield* columnExists(sql, "projection_projects", "default_target_ref"))) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN default_target_ref TEXT`;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_worktree_workspaces_project
    ON projection_worktree_workspaces(project_id, created_at)
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_worktree_workspaces_active_path
    ON projection_worktree_workspaces(path)
    WHERE path IS NOT NULL AND deleted_at IS NULL
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_worktree_workspaces_active_branch
    ON projection_worktree_workspaces(repository_identity, branch)
    WHERE repository_identity IS NOT NULL AND branch IS NOT NULL AND deleted_at IS NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_workspace_id
    ON projection_threads(workspace_id)
  `;
});
