import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Group lifecycle: pause/archive are persisted on the coordinator config so
  // they survive restarts; paused_automation_ids remembers which automations a
  // pause disabled so resume re-enables exactly that set (never user-disabled
  // ones).
  if (!(yield* columnExists(sql, "project_agent_configs", "paused_at"))) {
    yield* sql.unsafe(`
      ALTER TABLE project_agent_configs
      ADD COLUMN paused_at TEXT
    `);
  }

  if (!(yield* columnExists(sql, "project_agent_configs", "archived_at"))) {
    yield* sql.unsafe(`
      ALTER TABLE project_agent_configs
      ADD COLUMN archived_at TEXT
    `);
  }

  if (!(yield* columnExists(sql, "project_agent_configs", "paused_automation_ids"))) {
    yield* sql.unsafe(`
      ALTER TABLE project_agent_configs
      ADD COLUMN paused_automation_ids TEXT
    `);
  }
});
