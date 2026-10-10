import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "project_agent_configs", "goal"))) {
    yield* sql.unsafe(`
      ALTER TABLE project_agent_configs
      ADD COLUMN goal TEXT
    `);
  }

  if (!(yield* columnExists(sql, "project_agent_configs", "icon"))) {
    yield* sql.unsafe(`
      ALTER TABLE project_agent_configs
      ADD COLUMN icon TEXT
    `);
  }

  if (!(yield* columnExists(sql, "project_agent_configs", "auto_memory_enabled"))) {
    yield* sql.unsafe(`
      ALTER TABLE project_agent_configs
      ADD COLUMN auto_memory_enabled INTEGER NOT NULL DEFAULT 0
    `);
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_agent_linked_projects (
      project_id TEXT NOT NULL,
      linked_project_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, linked_project_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_agent_linked_projects_linked
    ON project_agent_linked_projects (linked_project_id)
  `;
});
