// Shared read-time Claude accounting for Profile Stats and deletion snapshots.
// Old compact modelUsage may be process-cumulative: only versioned results or
// retained per-turn main-loop usage are safe. Never infer a version from dates.
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export function claudeTokenActivityCtes(
  sql: SqlClient.SqlClient,
  scope?: { readonly threadId: string },
) {
  return sql`
    claude_completed_source AS (
      SELECT
        a.thread_id,
        a.turn_id,
        a.activity_id,
        a.sequence,
        a.created_at,
        CASE WHEN json_valid(a.payload_json) THEN a.payload_json ELSE '{}' END AS payload_json
      FROM projection_thread_activities a
      WHERE a.kind = 'turn.completed' AND a.turn_id IS NOT NULL
        ${scope ? sql`AND a.thread_id = ${scope.threadId}` : sql.literal("")}
    ),
    claude_completed_ranked AS (
      SELECT a.thread_id, a.turn_id, a.activity_id, a.created_at, a.payload_json,
        COALESCE(tm.model, CASE WHEN json_valid(th.model_selection_json)
          AND (json_extract(a.payload_json, '$.provider') IS NULL
            OR json_extract(a.payload_json, '$.provider') = json_extract(th.model_selection_json, '$.provider'))
          THEN json_extract(th.model_selection_json, '$.model') END, 'unknown') AS model,
        pm.dispatch_origin,
        ROW_NUMBER() OVER (
          PARTITION BY a.thread_id, a.turn_id
          ORDER BY a.sequence DESC, a.created_at DESC, a.activity_id DESC
        ) AS rank
      FROM claude_completed_source a
      JOIN projection_threads th ON th.thread_id = a.thread_id
      LEFT JOIN turn_model tm ON tm.thread_id = a.thread_id AND tm.turn_id = a.turn_id
      LEFT JOIN projection_turns pt ON pt.thread_id = a.thread_id AND pt.turn_id = a.turn_id
      LEFT JOIN projection_thread_messages pm
        ON pm.thread_id = pt.thread_id AND pm.message_id = pt.pending_message_id
      -- Provider-native children mirror usage that the parent result already
      -- includes. Other child threads are independent work and must count.
      WHERE COALESCE(th.creation_source, '') != 'provider_native'
        AND COALESCE(
          json_extract(a.payload_json, '$.provider'), tm.provider,
          CASE WHEN json_valid(th.model_selection_json)
            THEN json_extract(th.model_selection_json, '$.provider') END
        ) = 'claudeAgent'
    ),
    claude_completed AS (
      SELECT c.*,
        CASE WHEN json_extract(payload_json, '$.tokenAccountingVersion') = 1
          AND json_type(payload_json, '$.modelUsage') = 'object'
          THEN json_extract(payload_json, '$.modelUsage') END AS models,
        CASE WHEN json_extract(payload_json, '$.tokenAccountingVersion') = 1
          AND json_type(payload_json, '$.mainLoopTokens') IN ('integer', 'real')
          AND json_extract(payload_json, '$.mainLoopTokens') >= 0
          THEN CAST(json_extract(payload_json, '$.mainLoopTokens') AS INTEGER)
          ELSE legacy.tokens
        END AS main_tokens
      FROM claude_completed_ranked c
      LEFT JOIN profile_stats_claude_legacy_usage legacy
        ON legacy.thread_id = c.thread_id AND legacy.turn_id = c.turn_id
      WHERE rank = 1 AND (dispatch_origin IS NULL OR dispatch_origin = 'user')
    ),
    claude_model_usage_entries AS (
      SELECT c.activity_id, c.thread_id, c.turn_id, c.created_at, c.model AS fallback_model,
        m.key AS model,
        CASE WHEN json_valid(m.value) THEN
          CASE WHEN json_type(m.value) = 'object' THEN m.value ELSE '{}' END
        ELSE '{}' END AS usage
      FROM claude_completed c, json_each(c.models) m
    ),
    claude_model_token_candidates AS (
      SELECT activity_id, thread_id, turn_id, created_at,
        COALESCE(NULLIF(TRIM(CAST(model AS TEXT)), ''), fallback_model) AS model,
        CAST(
          CASE
            -- Private builds of this PR briefly stored a compact form whose
            -- inputTokens already included cache reads/writes. Its explicit
            -- total is authoritative so those cache subsets are not added twice.
            WHEN json_type(usage, '$.totalTokens') IN ('integer', 'real')
              AND json_extract(usage, '$.totalTokens') > 0
            THEN json_extract(usage, '$.totalTokens')
            -- The SDK modelUsage shape has no totalTokens. Its inputTokens is
            -- uncached input, so all four disjoint counters form the total.
            ELSE
              CASE WHEN json_type(usage, '$.inputTokens') IN ('integer', 'real')
                AND json_extract(usage, '$.inputTokens') >= 0
                THEN json_extract(usage, '$.inputTokens') ELSE 0 END
              + CASE WHEN json_type(usage, '$.cacheReadInputTokens') IN ('integer', 'real')
                AND json_extract(usage, '$.cacheReadInputTokens') >= 0
                THEN json_extract(usage, '$.cacheReadInputTokens') ELSE 0 END
              + CASE WHEN json_type(usage, '$.cacheCreationInputTokens') IN ('integer', 'real')
                AND json_extract(usage, '$.cacheCreationInputTokens') >= 0
                THEN json_extract(usage, '$.cacheCreationInputTokens') ELSE 0 END
              + CASE WHEN json_type(usage, '$.outputTokens') IN ('integer', 'real')
                AND json_extract(usage, '$.outputTokens') >= 0
                THEN json_extract(usage, '$.outputTokens') ELSE 0 END
          END AS INTEGER
        ) AS tokens
      FROM claude_model_usage_entries
    ),
    claude_model_token_rows AS (
      SELECT activity_id, thread_id, turn_id, created_at, model, tokens
      FROM claude_model_token_candidates
      WHERE tokens > 0
    ),
    claude_token_rows AS (
      SELECT thread_id, created_at, model, tokens
      FROM claude_model_token_rows
      UNION ALL
      SELECT c.thread_id, c.created_at, c.model, CAST(c.main_tokens AS INTEGER) AS tokens
      FROM claude_completed c
      WHERE c.main_tokens > 0
        AND NOT EXISTS (
          SELECT 1 FROM claude_model_token_rows m WHERE m.activity_id = c.activity_id
        )
    )
  `;
}
