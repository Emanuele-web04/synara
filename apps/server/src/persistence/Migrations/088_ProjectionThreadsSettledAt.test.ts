import { assert, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("088_ProjectionThreadsSettledAt", () => {
  it.effect("propagates schema failures and leaves migration 88 retryable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 87 });
      yield* sql`DROP TABLE projection_threads`;

      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 88 }));
      assert.isTrue(Exit.isFailure(exit));

      const tracker = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM effect_sql_migrations
        WHERE migration_id = 88
      `;
      assert.strictEqual(tracker[0]?.count, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
