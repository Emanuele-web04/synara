import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists, tableExists } from "./schemaHelpers.ts";

// Worker-monitoring liveness signals. `projection_thread_sessions.last_activity_at`
// is the durable last-runtime-activity timestamp fed (throttled) by provider
// ingestion so silence is measured from real work, not session lifecycle rows;
// `last_progress_at` stamps only work-producing events (agent output, tool
// lifecycle, turn boundaries) so a steer/nudge echo cannot pass as progress.
// `projection_thread_active_tools` tracks tool calls still in flight (started,
// not completed): idempotent INSERT OR IGNORE / DELETE writes keep it correct
// across the startup open-turn event replay. Managed workers gain the active
// turn's origin/command for turn-ownership checks plus the worker's latest
// structured report for settle rows.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_thread_sessions", "last_activity_at"))) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN last_activity_at TEXT
    `;
  }

  if (!(yield* columnExists(sql, "projection_thread_sessions", "last_progress_at"))) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN last_progress_at TEXT
    `;
  }

  if (!(yield* tableExists(sql, "projection_thread_active_tools"))) {
    yield* sql`
      CREATE TABLE IF NOT EXISTS projection_thread_active_tools (
        thread_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        turn_id TEXT,
        started_at TEXT NOT NULL,
        started_event_id TEXT NOT NULL,
        PRIMARY KEY (thread_id, item_id)
      )
    `;
  }

  // Managed-worker columns land in the migration that creates the table on
  // fresh installs; the guards also cover replays against pre-115 schemas.
  if (yield* tableExists(sql, "project_agent_managed_workers")) {
    if (!(yield* columnExists(sql, "project_agent_managed_workers", "active_turn_origin"))) {
      yield* sql`
        ALTER TABLE project_agent_managed_workers
        ADD COLUMN active_turn_origin TEXT
      `;
    }
    if (!(yield* columnExists(sql, "project_agent_managed_workers", "active_turn_command_id"))) {
      yield* sql`
        ALTER TABLE project_agent_managed_workers
        ADD COLUMN active_turn_command_id TEXT
      `;
    }
    if (!(yield* columnExists(sql, "project_agent_managed_workers", "result_summary"))) {
      yield* sql`
        ALTER TABLE project_agent_managed_workers
        ADD COLUMN result_summary TEXT
      `;
    }
    if (!(yield* columnExists(sql, "project_agent_managed_workers", "result_at"))) {
      yield* sql`
        ALTER TABLE project_agent_managed_workers
        ADD COLUMN result_at TEXT
      `;
    }
  }
});
