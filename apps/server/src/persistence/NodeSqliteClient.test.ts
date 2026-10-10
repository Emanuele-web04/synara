import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("NodeSqliteClient", (it) => {
  it.effect("does not suppress ordinary statement errors outside driver cleanup", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rollbackError = yield* sql.unsafe("ROLLBACK").pipe(Effect.flip);
      assert.match(String(rollbackError.cause), /no transaction is active/i);
      const error = yield* sql.unsafe("not valid SQL").pipe(Effect.flip);
      assert.match(String(error.cause), /syntax/i);
    }),
  );

  it.effect("preserves the original constraint failure after SQLite auto-rolls back", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE rollback_entries(id INTEGER PRIMARY KEY ON CONFLICT ROLLBACK)`;
      yield* sql`INSERT INTO rollback_entries(id) VALUES (1)`;
      const error = yield* sql
        .withTransaction(sql`INSERT INTO rollback_entries(id) VALUES (1)`)
        .pipe(Effect.flip);
      assert.match(String(error.cause), /UNIQUE constraint failed/i);
      const rows = yield* sql`SELECT id FROM rollback_entries`;
      assert.equal(rows.length, 1);
    }),
  );

  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");
    }),
  );
});
