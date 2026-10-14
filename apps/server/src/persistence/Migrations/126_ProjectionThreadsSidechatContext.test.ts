import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./126_ProjectionThreadsSidechatContext.ts";

describe("126_ProjectionThreadsSidechatContext", () => {
  it.effect("keeps existing threads and sidechats with no standalone context", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 125 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, sidechat_source_thread_id,
          created_at, updated_at
        ) VALUES (
          'sidechat-before-context', 'project-before-context', 'Sidechat: Existing',
          '{"provider":"codex","model":"gpt-5.4"}', 'source-thread',
          '2026-09-15T10:00:00.000Z', '2026-09-15T10:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 126 });
      const [row] = yield* sql<{
        readonly source: string | null;
        readonly context: string | null;
      }>`
        SELECT sidechat_source_thread_id AS source, sidechat_context_json AS context
        FROM projection_threads WHERE thread_id = 'sidechat-before-context'
      `;
      assert.deepStrictEqual(row, { source: "source-thread", context: null });

      // Reapplying the additive migration must not erase a stored context.
      const context =
        '{"kind":"github-item","itemKind":"issue","repository":"o/r","number":7,"url":"https://github.com/o/r/issues/7"}';
      yield* sql`
        UPDATE projection_threads SET sidechat_context_json = ${context}
        WHERE thread_id = 'sidechat-before-context'
      `;
      yield* migration;
      const [retained] = yield* sql<{ readonly context: string | null }>`
        SELECT sidechat_context_json AS context FROM projection_threads
        WHERE thread_id = 'sidechat-before-context'
      `;
      assert.strictEqual(retained?.context, context);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
