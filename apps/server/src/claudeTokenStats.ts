// Shared read-time Claude accounting for Profile Stats and deletion snapshots.
// Old compact modelUsage may be process-cumulative: only versioned results or
// retained per-turn main-loop usage are safe. Never infer a version from dates.
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export function claudeTokenActivityCtes(
  sql: SqlClient.SqlClient,
  scope?: { readonly threadId: string },
) {
  return sql`
    claude_completed_ranked AS (
      SELECT a.thread_id, a.turn_id, a.created_at, a.payload_json,
        COALESCE(tm.model, CASE WHEN json_valid(th.model_selection_json)
          AND (json_extract(a.payload_json, '$.provider') IS NULL
            OR json_extract(a.payload_json, '$.provider') = json_extract(th.model_selection_json, '$.provider'))
          THEN json_extract(th.model_selection_json, '$.model') END, 'unknown') AS model,
        pm.dispatch_origin,
        ROW_NUMBER() OVER (
          PARTITION BY a.thread_id, a.turn_id
          ORDER BY a.sequence DESC, a.created_at DESC, a.activity_id DESC
        ) AS rank
      FROM projection_thread_activities a
      JOIN projection_threads th ON th.thread_id = a.thread_id
      LEFT JOIN turn_model tm ON tm.thread_id = a.thread_id AND tm.turn_id = a.turn_id
      LEFT JOIN projection_turns pt ON pt.thread_id = a.thread_id AND pt.turn_id = a.turn_id
      LEFT JOIN projection_thread_messages pm
        ON pm.thread_id = pt.thread_id AND pm.message_id = pt.pending_message_id
      WHERE a.kind = 'turn.completed' AND a.turn_id IS NOT NULL
        AND th.parent_thread_id IS NULL
        ${scope ? sql`AND a.thread_id = ${scope.threadId}` : sql.literal("")}
        AND COALESCE(
          json_extract(a.payload_json, '$.provider'), tm.provider,
          CASE WHEN json_valid(th.model_selection_json)
            THEN json_extract(th.model_selection_json, '$.provider') END
        ) = 'claudeAgent'
    ),
    claude_completed AS (
      SELECT c.*,
        CASE WHEN json_extract(payload_json, '$.tokenAccountingVersion') = 1
          THEN json_extract(payload_json, '$.modelUsage') END AS models,
        CASE WHEN json_extract(payload_json, '$.tokenAccountingVersion') = 1
          THEN json_extract(payload_json, '$.mainLoopTokens')
          ELSE legacy.tokens
        END AS main_tokens
      FROM claude_completed_ranked c
      LEFT JOIN profile_stats_claude_legacy_usage legacy
        ON legacy.thread_id = c.thread_id AND legacy.turn_id = c.turn_id
      WHERE rank = 1 AND (dispatch_origin IS NULL OR dispatch_origin = 'user')
    ),
    claude_token_rows AS (
      SELECT c.thread_id, c.created_at, m.key AS model,
        CAST(json_extract(m.value, '$.totalTokens') AS INTEGER) AS tokens
      FROM claude_completed c, json_each(c.models) m
      WHERE json_extract(m.value, '$.totalTokens') > 0
      UNION ALL
      SELECT thread_id, created_at, model, CAST(main_tokens AS INTEGER) AS tokens
      FROM claude_completed
      WHERE (models IS NULL OR models = '{}') AND main_tokens > 0
    )
  `;
}
