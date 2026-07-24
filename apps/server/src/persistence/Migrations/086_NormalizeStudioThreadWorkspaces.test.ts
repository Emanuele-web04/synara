import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("086_NormalizeStudioThreadWorkspaces", (it) => {
  it.effect("clears legacy worktree metadata only from Studio threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 85 });

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          kind,
          title,
          workspace_root,
          scripts_json,
          created_at,
          updated_at
        ) VALUES
          (
            'studio-project',
            'studio',
            'Studio',
            '/workspace/Studio',
            '[]',
            '2026-07-24T10:00:00.000Z',
            '2026-07-24T10:00:00.000Z'
          ),
          (
            'regular-project',
            'project',
            'Regular',
            '/workspace/regular',
            '[]',
            '2026-07-24T10:00:00.000Z',
            '2026-07-24T10:00:00.000Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          branch,
          worktree_path,
          created_at,
          updated_at,
          runtime_mode,
          interaction_mode,
          env_mode,
          associated_worktree_path,
          associated_worktree_branch,
          associated_worktree_ref,
          create_branch_flow_completed
        ) VALUES
          (
            'studio-thread',
            'studio-project',
            'Studio thread',
            'feature/studio',
            '/workspace/external-folder',
            '2026-07-24T10:00:00.000Z',
            '2026-07-24T10:00:00.000Z',
            'full-access',
            'default',
            'worktree',
            '/workspace/external-folder',
            'feature/studio',
            'feature/studio',
            1
          ),
          (
            'regular-thread',
            'regular-project',
            'Regular thread',
            'feature/regular',
            '/workspace/worktrees/regular',
            '2026-07-24T10:00:00.000Z',
            '2026-07-24T10:00:00.000Z',
            'full-access',
            'default',
            'worktree',
            '/workspace/worktrees/regular',
            'feature/regular',
            'feature/regular',
            1
          )
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 86 });
      assert.deepStrictEqual(executed, [[86, "NormalizeStudioThreadWorkspaces"]]);

      const rows = yield* sql<{
        readonly threadId: string;
        readonly envMode: string;
        readonly branch: string | null;
        readonly worktreePath: string | null;
        readonly workingDirectory: string | null;
        readonly associatedWorktreePath: string | null;
        readonly createBranchFlowCompleted: number;
      }>`
        SELECT
          thread_id AS "threadId",
          env_mode AS "envMode",
          branch,
          worktree_path AS "worktreePath",
          working_directory AS "workingDirectory",
          associated_worktree_path AS "associatedWorktreePath",
          create_branch_flow_completed AS "createBranchFlowCompleted"
        FROM projection_threads
        ORDER BY thread_id
      `;

      assert.deepStrictEqual(rows, [
        {
          threadId: "regular-thread",
          envMode: "worktree",
          branch: "feature/regular",
          worktreePath: "/workspace/worktrees/regular",
          workingDirectory: null,
          associatedWorktreePath: "/workspace/worktrees/regular",
          createBranchFlowCompleted: 1,
        },
        {
          threadId: "studio-thread",
          envMode: "local",
          branch: null,
          worktreePath: null,
          workingDirectory: "/workspace/external-folder",
          associatedWorktreePath: null,
          createBranchFlowCompleted: 0,
        },
      ]);
    }),
  );
});
