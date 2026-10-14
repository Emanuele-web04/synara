import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

// Durable stall-recovery state for the worker ladder driven by
// `inspectManagedWorkerHealth`: the recorded task prompt lets a restart still
// re-dispatch, the episode/step fields dedupe each automatic action per silent
// episode, `recoveries_used` enforces the per-thread cap, and `needs_you`
// latches the terminal "Waiting on you" state.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "project_agent_managed_workers", "task_prompt"))) {
    yield* sql`
      ALTER TABLE project_agent_managed_workers
      ADD COLUMN task_prompt TEXT
    `;
  }
  if (!(yield* columnExists(sql, "project_agent_managed_workers", "recovery_episode"))) {
    yield* sql`
      ALTER TABLE project_agent_managed_workers
      ADD COLUMN recovery_episode TEXT
    `;
  }
  if (!(yield* columnExists(sql, "project_agent_managed_workers", "recovery_step"))) {
    yield* sql`
      ALTER TABLE project_agent_managed_workers
      ADD COLUMN recovery_step INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!(yield* columnExists(sql, "project_agent_managed_workers", "nudge_at"))) {
    yield* sql`
      ALTER TABLE project_agent_managed_workers
      ADD COLUMN nudge_at TEXT
    `;
  }
  if (!(yield* columnExists(sql, "project_agent_managed_workers", "recoveries_used"))) {
    yield* sql`
      ALTER TABLE project_agent_managed_workers
      ADD COLUMN recoveries_used INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!(yield* columnExists(sql, "project_agent_managed_workers", "needs_you"))) {
    yield* sql`
      ALTER TABLE project_agent_managed_workers
      ADD COLUMN needs_you INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!(yield* columnExists(sql, "project_agent_managed_workers", "needs_you_at"))) {
    yield* sql`
      ALTER TABLE project_agent_managed_workers
      ADD COLUMN needs_you_at TEXT
    `;
  }
});
