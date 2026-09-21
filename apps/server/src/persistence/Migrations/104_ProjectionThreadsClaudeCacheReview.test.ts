import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./104_ProjectionThreadsClaudeCacheReview.ts";

describe("104_ProjectionThreadsClaudeCacheReview", () => {
  it.effect("preserves existing threads with an empty cache review on upgrade", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 103 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, created_at, updated_at
        ) VALUES (
          'thread-before-cache-review', 'project-before-cache-review', 'Existing thread',
          '{"provider":"claudeAgent","model":"claude-opus-4-6"}',
          '2026-09-15T10:00:00.000Z', '2026-09-15T10:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 104 });
      const [row] = yield* sql<{ readonly title: string; readonly review: string | null }>`
        SELECT title, claude_cache_review_json AS review FROM projection_threads
        WHERE thread_id = 'thread-before-cache-review'
      `;
      assert.deepStrictEqual(row, { title: "Existing thread", review: null });

      // reapplying the additive migration must not erase a pending decision
      const review = '{"reviewId":"preserved-review"}';
      yield* sql`
        UPDATE projection_threads SET claude_cache_review_json = ${review}
        WHERE thread_id = 'thread-before-cache-review'
      `;
      yield* migration;
      const [retained] = yield* sql<{ readonly review: string | null }>`
        SELECT claude_cache_review_json AS review FROM projection_threads
        WHERE thread_id = 'thread-before-cache-review'
      `;
      assert.strictEqual(retained?.review, review);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("accepts an existing column without changing the migration identity", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 103 });
      yield* sql`ALTER TABLE projection_threads ADD COLUMN claude_cache_review_json TEXT`;
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 104 }), [
        [104, "ProjectionThreadsClaudeCacheReview"],
      ]);
      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_threads')
      `;
      assert.strictEqual(
        columns.filter((column) => column.name === "claude_cache_review_json").length,
        1,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
