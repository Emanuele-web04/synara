// Distinguish verified Claude deletion snapshots from older inflated counters.
// Existing history stays untouched; it cannot safely be repaired from totals.
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "profile_stats_deleted_tokens", "token_accounting_version"))) {
    yield* sql`ALTER TABLE profile_stats_deleted_tokens ADD COLUMN token_accounting_version INTEGER`;
  }
  yield* sql`
    CREATE TABLE IF NOT EXISTS profile_stats_claude_legacy_usage (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      tokens INTEGER NOT NULL CHECK(tokens >= 0),
      PRIMARY KEY (thread_id, turn_id)
    ) WITHOUT ROWID
  `;
  // Capture retained, per-turn main-loop evidence before runtime retention removes
  // it. Leave compact modelUsage and the immutable event journal untouched.
  yield* sql`
    INSERT OR IGNORE INTO profile_stats_claude_legacy_usage (thread_id, turn_id, tokens)
    SELECT thread_id, turn_id, CAST(tokens AS INTEGER) FROM (
      SELECT thread_id, turn_id,
        ROW_NUMBER() OVER (PARTITION BY thread_id, turn_id ORDER BY sequence DESC) AS rank,
        COALESCE(
          json_extract(event_json, '$.payload.usage.total_tokens'),
          json_extract(event_json, '$.payload.usage.input_tokens')
            + COALESCE(json_extract(event_json, '$.payload.usage.cache_creation_input_tokens'), 0)
            + COALESCE(json_extract(event_json, '$.payload.usage.cache_read_input_tokens'), 0)
            + COALESCE(json_extract(event_json, '$.payload.usage.output_tokens'), 0)
        ) AS tokens
      FROM provider_runtime_events
      WHERE event_type = 'turn.completed' AND turn_id IS NOT NULL
        AND json_extract(event_json, '$.provider') = 'claudeAgent'
        AND json_extract(event_json, '$.payload.tokenAccountingVersion') IS NULL
    ) WHERE rank = 1 AND tokens >= 0
  `;
});
