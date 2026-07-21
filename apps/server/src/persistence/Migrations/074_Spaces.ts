// FILE: 074_Spaces.ts
// Purpose: Adds durable custom spaces and nullable project assignments.
// Layer: SQLite migration

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_spaces (
      space_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_spaces_active_order
    ON projection_spaces(deleted_at, sort_order, space_id)
  `;

  if (!(yield* columnExists(sql, "projection_projects", "space_id"))) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN space_id TEXT`;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_space_id
    ON projection_projects(space_id)
  `;
});
