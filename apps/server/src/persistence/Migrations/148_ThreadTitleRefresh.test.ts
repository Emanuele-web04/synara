import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import threadTitleRefreshSchema from "./148_ThreadTitleRefresh.ts";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("148_ThreadTitleRefresh", () => {
  it.effect("adds title-refresh columns with safe defaults and stays idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 147 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_threads')
      `;
      assert.isFalse(before.some((column) => column.name === "manual_title_pinned"));

      yield* runMigrations({ toMigrationInclusive: 148 });

      const afterThreads = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_threads')
      `;
      for (const column of [
        "manual_title_pinned",
        "title_refresh_mode",
        "pending_suggested_title",
      ]) {
        assert.isTrue(
          afterThreads.some((entry) => entry.name === column),
          `missing projection_threads.${column}`,
        );
      }

      const afterProjects = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_projects')
      `;
      assert.isTrue(afterProjects.some((entry) => entry.name === "title_refresh_mode"));

      // Exercise the additive schema itself after the loader has applied it.
      yield* threadTitleRefreshSchema;
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
