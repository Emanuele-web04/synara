// Shared completed-turn attribution for live usage and deletion snapshots.
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { tokenStatsThreadFilter, type TokenStatsThreadScope } from "./claudeTokenStats";

export function completedTurnUsageCtes(sql: SqlClient.SqlClient, scope?: TokenStatsThreadScope) {
  return sql`
    usage_completed_source AS (
      SELECT a.*, CASE WHEN json_valid(a.payload_json) THEN a.payload_json ELSE '{}' END AS safe_payload
      FROM projection_thread_activities a
      WHERE a.kind = 'turn.completed' AND a.turn_id IS NOT NULL
        ${tokenStatsThreadFilter(sql, sql.literal("a.thread_id"), scope)}
    ),
    usage_completed_ranked AS (
      SELECT a.activity_id, a.thread_id, a.turn_id, a.created_at, a.safe_payload AS payload,
        COALESCE(tm.provider,
          CASE WHEN tm.instanceId = s.provider_instance_id THEN s.provider_name ELSE tm.instanceId END,
          json_extract(a.safe_payload, '$.provider'),
          CASE WHEN json_valid(th.model_selection_json) THEN json_extract(th.model_selection_json, '$.provider') END,
          s.provider_name, 'unknown') AS provider,
        COALESCE(tm.instanceId,
          CASE WHEN json_valid(th.model_selection_json) THEN json_extract(th.model_selection_json, '$.instanceId') END,
          s.provider_instance_id, tm.provider, json_extract(a.safe_payload, '$.provider'),
          CASE WHEN json_valid(th.model_selection_json) THEN json_extract(th.model_selection_json, '$.provider') END,
          s.provider_name, 'unknown') AS instanceId,
        COALESCE(tm.model,
          CASE WHEN json_valid(th.model_selection_json) THEN json_extract(th.model_selection_json, '$.model') END,
          'unknown') AS model,
        pm.dispatch_origin,
        ROW_NUMBER() OVER (PARTITION BY a.thread_id, a.turn_id
          ORDER BY a.sequence DESC, a.created_at DESC, a.activity_id DESC) AS rank
      FROM usage_completed_source a
      JOIN projection_threads th ON th.thread_id = a.thread_id
      LEFT JOIN projection_thread_sessions s ON s.thread_id = a.thread_id
      LEFT JOIN turn_model tm ON tm.thread_id = a.thread_id AND tm.turn_id = a.turn_id
      LEFT JOIN projection_turns pt ON pt.thread_id = a.thread_id AND pt.turn_id = a.turn_id
      LEFT JOIN projection_thread_messages pm ON pm.thread_id = pt.thread_id AND pm.message_id = pt.pending_message_id
    ),
    usage_completed AS (
      SELECT * FROM usage_completed_ranked WHERE rank = 1
    ),
    usage_model_entries AS (
      SELECT c.*, m.key AS usage_model,
        CASE WHEN json_valid(m.value) THEN
          CASE WHEN json_type(m.value) = 'object' THEN m.value ELSE '{}' END
        ELSE '{}' END AS usage
      FROM usage_completed c,
        json_each(CASE WHEN json_type(c.payload, '$.modelUsage') = 'object'
          THEN json_extract(c.payload, '$.modelUsage') ELSE '{}' END) m
      -- Claude has separately versioned accounting; never accept its legacy totals.
      WHERE c.provider != 'claudeAgent'
    ),
    usage_model_token_rows AS (
      SELECT thread_id, turn_id, created_at, provider, instanceId,
        COALESCE(NULLIF(TRIM(CAST(usage_model AS TEXT)), ''), model) AS model,
        dispatch_origin, CAST(json_extract(usage, '$.totalTokens') AS INTEGER) AS tokens
      FROM usage_model_entries
      WHERE json_type(usage, '$.totalTokens') IN ('integer', 'real')
        AND json_extract(usage, '$.totalTokens') > 0
    )
  `;
}
