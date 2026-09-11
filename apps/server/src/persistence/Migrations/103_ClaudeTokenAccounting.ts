// Distinguish verified Claude deletion snapshots from older inflated counters.
// Existing history stays untouched; it cannot safely be repaired from totals.
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "profile_stats_deleted_tokens", "token_accounting_version"))) {
    // Keep this extensible: readers opt into versions they understand, while a
    // future writer must not need a table rebuild merely to preserve a snapshot.
    yield* sql`
      ALTER TABLE profile_stats_deleted_tokens ADD COLUMN token_accounting_version INTEGER
    `;
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
    WITH claude_result_source AS (
      SELECT sequence, thread_id, turn_id,
        CASE WHEN json_valid(event_json) THEN event_json ELSE '{}' END AS event_json
      FROM provider_runtime_events
      WHERE event_type = 'turn.completed' AND turn_id IS NOT NULL
    ),
    claude_result_ranked AS (
      SELECT thread_id, turn_id, event_json,
        ROW_NUMBER() OVER (PARTITION BY thread_id, turn_id ORDER BY sequence DESC) AS rank
      FROM claude_result_source
      WHERE json_extract(event_json, '$.provider') = 'claudeAgent'
        AND json_extract(event_json, '$.payload.tokenAccountingVersion') IS NULL
        AND json_type(event_json, '$.payload.usage') = 'object'
        AND (
          (json_type(event_json, '$.payload.usage.total_tokens') IN ('integer', 'real')
            AND json_extract(event_json, '$.payload.usage.total_tokens') >= 0)
          OR (json_type(event_json, '$.payload.usage.input_tokens') IN ('integer', 'real')
            AND json_extract(event_json, '$.payload.usage.input_tokens') >= 0)
          OR (json_type(event_json, '$.payload.usage.cache_creation_input_tokens') IN ('integer', 'real')
            AND json_extract(event_json, '$.payload.usage.cache_creation_input_tokens') >= 0)
          OR (json_type(event_json, '$.payload.usage.cache_read_input_tokens') IN ('integer', 'real')
            AND json_extract(event_json, '$.payload.usage.cache_read_input_tokens') >= 0)
          OR (json_type(event_json, '$.payload.usage.output_tokens') IN ('integer', 'real')
            AND json_extract(event_json, '$.payload.usage.output_tokens') >= 0)
        )
    ),
    claude_result_tokens AS (
      SELECT thread_id, turn_id,
        CASE
          WHEN json_type(event_json, '$.payload.usage.total_tokens') IN ('integer', 'real')
            AND json_extract(event_json, '$.payload.usage.total_tokens') >= 0
            THEN json_extract(event_json, '$.payload.usage.total_tokens')
          WHEN (
            (json_type(event_json, '$.payload.usage.input_tokens') IN ('integer', 'real')
              AND json_extract(event_json, '$.payload.usage.input_tokens') >= 0)
            OR (json_type(event_json, '$.payload.usage.cache_creation_input_tokens') IN ('integer', 'real')
              AND json_extract(event_json, '$.payload.usage.cache_creation_input_tokens') >= 0)
            OR (json_type(event_json, '$.payload.usage.cache_read_input_tokens') IN ('integer', 'real')
              AND json_extract(event_json, '$.payload.usage.cache_read_input_tokens') >= 0)
            OR (json_type(event_json, '$.payload.usage.output_tokens') IN ('integer', 'real')
              AND json_extract(event_json, '$.payload.usage.output_tokens') >= 0)
          ) THEN
            CASE WHEN json_type(event_json, '$.payload.usage.input_tokens') IN ('integer', 'real')
                AND json_extract(event_json, '$.payload.usage.input_tokens') >= 0
              THEN json_extract(event_json, '$.payload.usage.input_tokens') ELSE 0 END
            + CASE WHEN json_type(event_json, '$.payload.usage.cache_creation_input_tokens') IN ('integer', 'real')
                AND json_extract(event_json, '$.payload.usage.cache_creation_input_tokens') >= 0
              THEN json_extract(event_json, '$.payload.usage.cache_creation_input_tokens') ELSE 0 END
            + CASE WHEN json_type(event_json, '$.payload.usage.cache_read_input_tokens') IN ('integer', 'real')
                AND json_extract(event_json, '$.payload.usage.cache_read_input_tokens') >= 0
              THEN json_extract(event_json, '$.payload.usage.cache_read_input_tokens') ELSE 0 END
            + CASE WHEN json_type(event_json, '$.payload.usage.output_tokens') IN ('integer', 'real')
                AND json_extract(event_json, '$.payload.usage.output_tokens') >= 0
              THEN json_extract(event_json, '$.payload.usage.output_tokens') ELSE 0 END
          ELSE NULL
        END AS tokens
      FROM claude_result_ranked
      WHERE rank = 1
    )
    SELECT thread_id, turn_id, CAST(tokens AS INTEGER)
    FROM claude_result_tokens
    WHERE tokens IS NOT NULL AND tokens >= 0
  `;
});
