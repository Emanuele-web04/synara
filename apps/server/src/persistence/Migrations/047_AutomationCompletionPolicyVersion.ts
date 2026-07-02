// FILE: 047_AutomationCompletionPolicyVersion.ts
// Purpose: Adds a durable stop-policy version so in-flight heartbeat runs cannot inherit edits.
// Layer: Server persistence migration
// Depends on: automation_definitions and schemaHelpers.columnExists.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "automation_definitions", "completion_policy_version"))) {
    yield* sql`
      ALTER TABLE automation_definitions
      ADD COLUMN completion_policy_version INTEGER NOT NULL DEFAULT 0
    `;
  }

  if (!(yield* columnExists(sql, "automation_definitions", "completion_policy_updated_at"))) {
    yield* sql`
      ALTER TABLE automation_definitions
      ADD COLUMN completion_policy_updated_at TEXT
    `;
  }

  yield* sql`
    UPDATE automation_definitions
    SET completion_policy_updated_at = COALESCE(
      completion_policy_updated_at,
      updated_at,
      created_at,
      '1970-01-01T00:00:00.000Z'
    )
  `;
});
