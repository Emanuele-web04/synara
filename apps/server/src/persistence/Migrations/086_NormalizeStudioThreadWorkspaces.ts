// Purpose: Repairs Studio threads that older web clients encoded as worktrees when the
//          composer "Use a folder" control selected an ordinary local directory.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN working_directory TEXT
  `;

  yield* sql`
    UPDATE projection_threads
    SET working_directory = COALESCE(working_directory, worktree_path),
        env_mode = 'local',
        branch = NULL,
        worktree_path = NULL,
        associated_worktree_path = NULL,
        associated_worktree_branch = NULL,
        associated_worktree_ref = NULL,
        create_branch_flow_completed = 0
    WHERE project_id IN (
      SELECT project_id
      FROM projection_projects
      WHERE kind = 'studio'
        AND deleted_at IS NULL
    )
      AND (
        env_mode <> 'local'
        OR branch IS NOT NULL
        OR worktree_path IS NOT NULL
        OR associated_worktree_path IS NOT NULL
        OR associated_worktree_branch IS NOT NULL
        OR associated_worktree_ref IS NOT NULL
        OR create_branch_flow_completed <> 0
      )
  `;
});
