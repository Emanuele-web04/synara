import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The wake cursor previously ordered by inbox_id only, but inbox ids are
  // random UUIDs while rows are read in created_at order. Keyset pagination
  // needs the created_at of the last processed row alongside its id.
  if (!(yield* columnExists(sql, "project_agent_cursors", "processed_through_created_at"))) {
    yield* sql.unsafe(`
      ALTER TABLE project_agent_cursors
      ADD COLUMN processed_through_created_at TEXT
    `);
  }

  if (!(yield* columnExists(sql, "project_agent_cursors", "coordinator_busy_since"))) {
    yield* sql.unsafe(`
      ALTER TABLE project_agent_cursors
      ADD COLUMN coordinator_busy_since TEXT
    `);
  }

  // Backfill the created_at half of the keyset cursor from the processed row so
  // already-advanced cursors keep their position instead of replaying the inbox.
  yield* sql.unsafe(`
    UPDATE project_agent_cursors
    SET processed_through_created_at = (
      SELECT created_at FROM project_agent_event_inbox
      WHERE project_agent_event_inbox.inbox_id = project_agent_cursors.processed_through_inbox_id
    )
    WHERE processed_through_inbox_id IS NOT NULL
      AND processed_through_created_at IS NULL
  `);

  // A coordinator that crashed mid-wake left coordinator_busy latched forever;
  // recovery needs a timestamp to distinguish a live dispatch from a stale one.
  yield* sql.unsafe(`
    UPDATE project_agent_cursors
    SET coordinator_busy_since = updated_at
    WHERE coordinator_busy = 1
      AND coordinator_busy_since IS NULL
  `);
});
