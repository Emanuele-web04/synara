import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const projectionThreadsColumnNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

const projectionThreadMessagesColumnNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_thread_messages')
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

const projectionProjectsColumnNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_projects')
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

layer("032_ReconcileLegacyT3SchemaImport", (it) => {
  // Simulates a legacy ~/.t3 import where the imported `effect_sql_migrations`
  // tracker has IDs 17-31 recorded under unrelated T3 Code names. The 17-31
  // body never ran, so the columns those migrations would have added are
  // missing. Without #032, the server crashes on the first SELECT that
  // references env_mode.
  it.effect("heals an imported T3 Code DB whose tracker skipped 17-31", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Bring the schema to where T3 Code and DP Code last agreed.
      yield* runMigrations({ toMigrationInclusive: 16 });

      // Mark IDs 17-31 applied under T3 Code's old names so the migrator
      // skips DP Code's renumbered 17-23. Names are illustrative; only the
      // IDs matter to the migrator's "run anything past max(id)" gate.
      const legacyT3MigrationNames: ReadonlyArray<readonly [number, string]> = [
        [17, "ProjectionThreadsArchivedAt"],
        [18, "ProjectionThreadsArchivedAtIndex"],
        [19, "ProjectionSnapshotLookupIndexes"],
        [20, "AuthAccessManagement"],
        [21, "AuthSessionClientMetadata"],
        [22, "AuthSessionLastConnectedAt"],
        [23, "ProjectionThreadShellSummary"],
        [24, "BackfillProjectionThreadShellSummary"],
        [25, "ProjectionThreadsSubagents"],
        [26, "ProjectionThreadShellSummary"],
        [27, "BackfillProjectionThreadShellSummary"],
        [28, "ProjectionProjectsKind"],
        [29, "ProjectionThreadsLastKnownPr"],
        [30, "ProjectionThreadMessagesDispatchMode"],
        [31, "ProjectionThreadsCreateBranchFlowCompleted"],
      ];
      for (const [id, name] of legacyT3MigrationNames) {
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${id}, ${name})
        `;
      }

      // Seed a thread row with the T3 Code-era column set so the data-rewrite
      // branches in #032 have something to operate on.
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at,
          runtime_mode,
          interaction_mode
        )
        VALUES (
          'thread-legacy',
          'project-legacy',
          'Legacy thread',
          'feature/legacy',
          '/tmp/legacy-worktree',
          'turn-1',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL,
          'full-access',
          'default'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-user-1',
          'thread-legacy',
          'turn-1',
          'user',
          'Please make this change',
          0,
          '2026-01-01T00:00:01.000Z',
          '2026-01-01T00:00:01.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at,
          sequence
        )
        VALUES
          (
            'activity-approval-1',
            'thread-legacy',
            'turn-1',
            'info',
            'approval.requested',
            'Approval requested',
            '{"requestId":"approval-1"}',
            '2026-01-01T00:00:02.000Z',
            1
          ),
          (
            'activity-input-1',
            'thread-legacy',
            'turn-1',
            'info',
            'user-input.requested',
            'User input requested',
            '{"requestId":"input-1"}',
            '2026-01-01T00:00:03.000Z',
            2
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          created_at,
          updated_at,
          implemented_at,
          implementation_thread_id
        )
        VALUES (
          'plan-1',
          'thread-legacy',
          'turn-1',
          '- Do the thing',
          '2026-01-01T00:00:04.000Z',
          '2026-01-01T00:00:04.000Z',
          NULL,
          NULL
        )
      `;

      // Sanity check: env_mode shouldn't exist yet.
      const beforeColumns = yield* projectionThreadsColumnNames(sql);
      assert.notInclude(beforeColumns, "env_mode");

      // This is what runs on next launch.
      yield* runMigrations();

      const afterThreadsColumns = yield* projectionThreadsColumnNames(sql);
      const afterMessagesColumns = yield* projectionThreadMessagesColumnNames(sql);
      const afterProjectsColumns = yield* projectionProjectsColumnNames(sql);

      // #017 + #018 columns
      assert.include(afterThreadsColumns, "handoff_json");
      assert.include(afterMessagesColumns, "source");
      assert.include(afterMessagesColumns, "skills_json");
      assert.include(afterMessagesColumns, "mentions_json");

      // #019 + the columns from #020-#023
      assert.include(afterThreadsColumns, "env_mode");
      assert.include(afterThreadsColumns, "fork_source_thread_id");
      assert.include(afterThreadsColumns, "associated_worktree_path");
      assert.include(afterThreadsColumns, "associated_worktree_branch");
      assert.include(afterThreadsColumns, "associated_worktree_ref");

      // #024-#031 columns can be skipped by the same max-ID gate and must be
      // healed before read-model queries touch them on startup.
      assert.include(afterThreadsColumns, "archived_at");
      assert.include(afterThreadsColumns, "parent_thread_id");
      assert.include(afterThreadsColumns, "subagent_agent_id");
      assert.include(afterThreadsColumns, "subagent_nickname");
      assert.include(afterThreadsColumns, "subagent_role");
      assert.include(afterThreadsColumns, "latest_user_message_at");
      assert.include(afterThreadsColumns, "pending_approval_count");
      assert.include(afterThreadsColumns, "pending_user_input_count");
      assert.include(afterThreadsColumns, "has_actionable_proposed_plan");
      assert.include(afterProjectsColumns, "kind");
      assert.include(afterThreadsColumns, "last_known_pr_json");
      assert.include(afterMessagesColumns, "dispatch_mode");
      assert.include(afterThreadsColumns, "create_branch_flow_completed");

      // Data-rewrite branches: env_mode derived from worktree_path,
      // associated_* mirrored from existing branch / worktree fields.
      const [seeded] = yield* sql<{
        readonly env_mode: string;
        readonly associated_worktree_path: string | null;
        readonly associated_worktree_branch: string | null;
        readonly associated_worktree_ref: string | null;
        readonly latest_user_message_at: string | null;
        readonly pending_approval_count: number;
        readonly pending_user_input_count: number;
        readonly has_actionable_proposed_plan: number;
      }>`
        SELECT
          env_mode,
          associated_worktree_path,
          associated_worktree_branch,
          associated_worktree_ref,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan
        FROM projection_threads
        WHERE thread_id = 'thread-legacy'
      `;
      assert.strictEqual(seeded?.env_mode, "worktree");
      assert.strictEqual(seeded?.associated_worktree_path, "/tmp/legacy-worktree");
      assert.strictEqual(seeded?.associated_worktree_branch, "feature/legacy");
      assert.strictEqual(seeded?.associated_worktree_ref, "feature/legacy");
      assert.strictEqual(seeded?.latest_user_message_at, "2026-01-01T00:00:01.000Z");
      assert.strictEqual(seeded?.pending_approval_count, 1);
      assert.strictEqual(seeded?.pending_user_input_count, 1);
      assert.strictEqual(seeded?.has_actionable_proposed_plan, 1);

      const [pendingApproval] = yield* sql<{ readonly status: string }>`
        SELECT status
        FROM projection_pending_approvals
        WHERE request_id = 'approval-1'
      `;
      assert.strictEqual(pendingApproval?.status, "pending");
    }),
  );

  it.effect("is a no-op on a fresh DP Code install", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Run the entire chain in order, the way a fresh install would.
      yield* runMigrations();

      // Nothing should blow up if we run it again.
      yield* runMigrations();

      const threadsColumns = yield* projectionThreadsColumnNames(sql);
      const messagesColumns = yield* projectionThreadMessagesColumnNames(sql);

      // Columns from the regular in-order runs of 17-23 are still there,
      // confirming #032 didn't try to ADD COLUMN on top of existing ones.
      assert.include(threadsColumns, "env_mode");
      assert.include(threadsColumns, "associated_worktree_ref");
      assert.include(threadsColumns, "create_branch_flow_completed");
      assert.include(messagesColumns, "skills_json");
      assert.include(messagesColumns, "dispatch_mode");
    }),
  );
});
