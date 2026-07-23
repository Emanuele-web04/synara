// FILE: 083_AutomationHeartbeatEligibility.ts
// Purpose: Adds heartbeat cooldown configuration and durable deferred-run retries.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "automation_definitions", "heartbeat_cooldown_seconds"))) {
    yield* sql`
      ALTER TABLE automation_definitions
      ADD COLUMN heartbeat_cooldown_seconds INTEGER NOT NULL DEFAULT 60
    `;
  }

  if (!(yield* columnExists(sql, "automation_runs", "deferred_until"))) {
    yield* sql`
      ALTER TABLE automation_runs
      ADD COLUMN deferred_until TEXT
    `;
  }
});
