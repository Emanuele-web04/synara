import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "project_agent_configs", "library_path"))) {
    yield* sql.unsafe(`
      ALTER TABLE project_agent_configs
      ADD COLUMN library_path TEXT
    `);
  }

  if (!(yield* columnExists(sql, "project_agent_configs", "library_remote_url"))) {
    yield* sql.unsafe(`
      ALTER TABLE project_agent_configs
      ADD COLUMN library_remote_url TEXT
    `);
  }

  if (!(yield* columnExists(sql, "project_agent_configs", "library_push_on_change"))) {
    yield* sql.unsafe(`
      ALTER TABLE project_agent_configs
      ADD COLUMN library_push_on_change INTEGER NOT NULL DEFAULT 0
    `);
  }
});
