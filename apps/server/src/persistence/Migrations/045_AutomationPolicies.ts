// FILE: 045_AutomationPolicies.ts
// Purpose: Adds explicit scheduling policy fields to automation definitions.
// Layer: Server persistence migration
// Depends on: 044_Automations and schemaHelpers.columnExists.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "automation_definitions", "minimum_interval_seconds"))) {
    yield* sql`
      ALTER TABLE automation_definitions
      ADD COLUMN minimum_interval_seconds INTEGER NOT NULL DEFAULT 60
    `;
  }

  if (!(yield* columnExists(sql, "automation_definitions", "max_runtime_seconds"))) {
    yield* sql`
      ALTER TABLE automation_definitions
      ADD COLUMN max_runtime_seconds INTEGER DEFAULT 3600
    `;
  }

  if (!(yield* columnExists(sql, "automation_definitions", "retry_policy_json"))) {
    yield* sql`
      ALTER TABLE automation_definitions
      ADD COLUMN retry_policy_json TEXT NOT NULL DEFAULT '{"type":"none"}'
    `;
  }

  if (!(yield* columnExists(sql, "automation_definitions", "misfire_policy"))) {
    yield* sql`
      ALTER TABLE automation_definitions
      ADD COLUMN misfire_policy TEXT NOT NULL DEFAULT 'coalesce'
    `;
  }

  if (!(yield* columnExists(sql, "automation_definitions", "acknowledged_risks_json"))) {
    yield* sql`
      ALTER TABLE automation_definitions
      ADD COLUMN acknowledged_risks_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
});
