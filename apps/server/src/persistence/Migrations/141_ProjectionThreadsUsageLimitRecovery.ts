import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

// Additive and replay-safe: existing failures remain unscheduled.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "projection_threads", "usage_limit_recovery_source_json"))) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN usage_limit_recovery_source_json TEXT`;
  }
  if (!(yield* columnExists(sql, "projection_threads", "usage_limit_recovery_json"))) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN usage_limit_recovery_json TEXT`;
  }
  if (!(yield* columnExists(sql, "projection_threads", "usage_limit_recovery_cancelled_at"))) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN usage_limit_recovery_cancelled_at TEXT`;
  }
  if (!(yield* columnExists(sql, "projection_threads", "usage_limit_recovery_cancelled_turn_id"))) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN usage_limit_recovery_cancelled_turn_id TEXT`;
  }
  if (!(yield* columnExists(sql, "projection_threads", "usage_limit_recovery_last_reset_at"))) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN usage_limit_recovery_last_reset_at TEXT`;
  }
  // Sparse quota-chain lookup for suspended controllers; transcript rows are never scanned.
  yield* sql`CREATE INDEX IF NOT EXISTS idx_orch_usage_limit_recovery_source
    ON orchestration_events(stream_id,json_extract(payload_json,'$.usageLimitRecovery.turnId'),sequence)
    WHERE aggregate_kind='thread' AND event_type='thread.meta-updated'
      AND json_type(payload_json,'$.usageLimitRecovery')='object'`;
});
