// FILE: 046_AutomationCompletionPolicy.ts
// Purpose: Adds first-class heartbeat stop policy storage to automation definitions.
// Layer: Server persistence migration
// Depends on: 044_Automations and schemaHelpers.columnExists.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "automation_definitions", "completion_policy_json"))) {
    yield* sql`
      ALTER TABLE automation_definitions
      ADD COLUMN completion_policy_json TEXT NOT NULL DEFAULT '{"type":"none"}'
    `;
  }
});
