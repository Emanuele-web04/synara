import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("070_WorktreeWorkspaces migration", (it) => {
  it.effect("adds workspace metadata without changing existing conversation data", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });

      const createdAt = "2026-07-15T00:00:00.000Z";
      const attachments = [
        {
          type: "image",
          id: "legacy-thread-image",
          name: "existing-screenshot.png",
          mimeType: "image/png",
          sizeBytes: 2048,
        },
      ];
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'legacy-project', 'project', 'Legacy project', '/tmp/legacy-project',
          ${JSON.stringify({ provider: "codex", model: "gpt-5.5" })}, '[]',
          ${createdAt}, ${createdAt}, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, branch, worktree_path,
          created_at, updated_at, deleted_at
        ) VALUES (
          'legacy-thread', 'legacy-project', 'Preserved conversation',
          ${JSON.stringify({ provider: "codex", model: "gpt-5.5" })},
          'feature/legacy', '/tmp/legacy-worktree', ${createdAt}, ${createdAt}, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, attachments_json,
          created_at, updated_at
        ) VALUES (
          'legacy-message', 'legacy-thread', NULL, 'user', 'Keep this message', 0,
          ${JSON.stringify(attachments)}, ${createdAt}, ${createdAt}
        )
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 70 });
      assert.deepStrictEqual(executed.at(-1), [70, "WorktreeWorkspaces"]);

      const [thread] = yield* sql<{
        readonly threadId: string;
        readonly projectId: string;
        readonly workspaceId: string | null;
        readonly title: string;
        readonly branch: string | null;
        readonly worktreePath: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          workspace_id AS "workspaceId",
          title,
          branch,
          worktree_path AS "worktreePath"
        FROM projection_threads
        WHERE thread_id = 'legacy-thread'
      `;
      const [message] = yield* sql<{
        readonly messageId: string;
        readonly text: string;
        readonly attachmentsJson: string | null;
      }>`
        SELECT
          message_id AS "messageId",
          text,
          attachments_json AS "attachmentsJson"
        FROM projection_thread_messages
        WHERE message_id = 'legacy-message'
      `;

      assert.deepStrictEqual(thread, {
        threadId: "legacy-thread",
        projectId: "legacy-project",
        workspaceId: null,
        title: "Preserved conversation",
        branch: "feature/legacy",
        worktreePath: "/tmp/legacy-worktree",
      });
      assert.deepStrictEqual(message, {
        messageId: "legacy-message",
        text: "Keep this message",
        attachmentsJson: JSON.stringify(attachments),
      });
    }),
  );
});
