// FILE: 084_AutomationNotificationPolicy.ts
// Purpose: Adds the additive successful-run notification policy.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "automation_definitions", "notification_policy"))) {
    yield* sql`
      ALTER TABLE automation_definitions
      ADD COLUMN notification_policy TEXT
      CHECK (
        notification_policy IS NULL
        OR notification_policy IN ('all', 'failed-runs-only')
      )
    `;
  }
});
