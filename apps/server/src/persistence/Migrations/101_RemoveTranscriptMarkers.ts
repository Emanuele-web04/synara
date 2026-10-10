/** Retire transcript markers while preserving event identities and replay cursors. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Keep sequence/stream-version continuity for reconnects and projection rebuilds.
  // A metadata event containing only updatedAt preserves the original timestamp
  // effect without retaining marker payloads or requiring legacy runtime handlers.
  yield* sql`
    UPDATE orchestration_events
    SET event_type = 'thread.meta-updated',
        payload_json = json_object(
          'threadId', stream_id,
          'updatedAt', COALESCE(json_extract(payload_json, '$.updatedAt'), occurred_at)
        )
    WHERE event_type IN (
      'thread.marker-added', 'thread.marker-removed',
      'thread.marker-done-set', 'thread.marker-label-set'
    )
  `;
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_remove(payload_json, '$.threadMarkers')
    WHERE event_type = 'thread.meta-updated'
      AND json_type(payload_json, '$.threadMarkers') IS NOT NULL
  `;

  if (yield* columnExists(sql, "projection_threads", "thread_markers_json")) {
    yield* sql`ALTER TABLE projection_threads DROP COLUMN thread_markers_json`;
  }
});
