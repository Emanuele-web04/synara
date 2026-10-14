import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "project_agent_configs", "coordinator_icon"))) {
    yield* sql.unsafe(`
      ALTER TABLE project_agent_configs
      ADD COLUMN coordinator_icon TEXT
    `);
  }

  if (!(yield* columnExists(sql, "project_agent_configs", "coordinator_color"))) {
    yield* sql.unsafe(`
      ALTER TABLE project_agent_configs
      ADD COLUMN coordinator_color TEXT
    `);
  }
});
