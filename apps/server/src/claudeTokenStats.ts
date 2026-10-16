// Shared read-time Claude accounting for Profile Stats and deletion snapshots.
// Old compact modelUsage may be process-cumulative: only versioned results or
// retained per-turn main-loop usage are safe. Never infer a version from dates.
// A versioned result that opened a resumed process is cumulative too; its turn
// counts its main loop instead.
// Rows keep every dispatch origin; callers pick which origins count.
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Statement from "effect/unstable/sql/Statement";

// Restricts token CTEs to one thread (delete-time archive) or to the threads a
// subquery returns (time-range recaps), so they skip unrelated history.
export type TokenStatsThreadScope =
  | { readonly threadId: string }
  | { readonly threadIdsQuery: Statement.Fragment };

export function tokenStatsThreadFilter(
  sql: SqlClient.SqlClient,
  column: Statement.Fragment,
  scope: TokenStatsThreadScope | undefined,
): Statement.Fragment {
  if (!scope) {
    return sql.literal("");
  }
  return "threadId" in scope
    ? sql`AND ${column} = ${scope.threadId}`
    : sql`AND ${column} IN (${scope.threadIdsQuery})`;
}

// The scope plus its threads' parents: a subagent's usage is judged against its
// parent's results even when the parent is outside the scope.
function tokenStatsLineageFilter(
  sql: SqlClient.SqlClient,
  column: Statement.Fragment,
  scope: TokenStatsThreadScope | undefined,
): Statement.Fragment {
  if (!scope) {
    return sql.literal("");
  }
  const threads = "threadId" in scope ? sql`SELECT ${scope.threadId}` : scope.threadIdsQuery;
  return sql`AND (${column} IN (${threads}) OR ${column} IN (
    SELECT parent_thread_id FROM projection_threads
    WHERE thread_id IN (${threads}) AND parent_thread_id IS NOT NULL
  ))`;
}

// A non-negative JSON number at `path`, else 0. Paths are constants, never input.
function jsonCount(sql: SqlClient.SqlClient, column: string, path: string): Statement.Fragment {
  return sql.literal(
    `CASE WHEN json_type(${column}, '${path}') IN ('integer', 'real')
      AND json_extract(${column}, '${path}') >= 0
      THEN json_extract(${column}, '${path}') ELSE 0 END`,
  );
}

// Tokens in one modelUsage entry (`entry` holds an object).
function modelUsageTokens(sql: SqlClient.SqlClient, entry: string): Statement.Fragment {
  const count = (field: string) =>
    `CASE WHEN json_type(${entry}, '$.${field}') IN ('integer', 'real')
      AND json_extract(${entry}, '$.${field}') >= 0
      THEN json_extract(${entry}, '$.${field}') ELSE 0 END`;
  return sql.literal(`CASE
    -- Private builds of this PR briefly stored a compact form whose
    -- inputTokens already included cache reads/writes. Its explicit
    -- total is authoritative so those cache subsets are not added twice.
    WHEN json_type(${entry}, '$.totalTokens') IN ('integer', 'real')
      AND json_extract(${entry}, '$.totalTokens') > 0
    THEN json_extract(${entry}, '$.totalTokens')
    -- The SDK modelUsage shape has no totalTokens. Its inputTokens is
    -- uncached input, so all four disjoint counters form the total.
    ELSE ${count("inputTokens")} + ${count("cacheReadInputTokens")}
      + ${count("cacheCreationInputTokens")} + ${count("outputTokens")}
  END`);
}

export function claudeTokenActivityCtes(sql: SqlClient.SqlClient, scope?: TokenStatsThreadScope) {
  const request = (field: string) =>
    jsonCount(sql, "a.payload_json", `$.claudeCache.lastRequest.${field}`);
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
        ${tokenStatsLineageFilter(sql, sql.literal("a.thread_id"), scope)}
    ),
    -- Query identity is stable across repeated hooks and independent of reused
    -- ownership generations. Legacy rows fall back to known native ownership;
    -- observation timestamps never imply a new process.
    claude_request_observations AS (
      SELECT
        a.thread_id,
        a.turn_id,
        a.created_at,
        a.sequence,
        a.activity_id,
        json_extract(a.payload_json, '$.claudeCache.lifecycleGeneration') AS lifecycle_generation,
        CASE WHEN json_type(a.payload_json, '$.claudeCache.processId') = 'text'
          THEN NULLIF(json_extract(a.payload_json, '$.claudeCache.processId'), '')
        END AS process_id,
        json_extract(a.payload_json, '$.claudeCache.nativeSessionId') AS native_session_id,
        COALESCE(
          json_extract(a.payload_json, '$.claudeCache.lastRequest.messageId'),
          a.activity_id
        ) AS message_id,
        ${request("cacheReadInputTokens")} AS cache_read_tokens
      FROM projection_thread_activities a
      WHERE a.kind = 'context-window.updated'
        ${tokenStatsLineageFilter(sql, sql.literal("a.thread_id"), scope)}
        AND json_valid(a.payload_json)
        AND json_type(a.payload_json, '$.claudeCache') = 'object'
    ),
    claude_request_source AS (
      SELECT r.*,
        COALESCE('process:' || process_id, 'legacy:' || lifecycle_generation)
          || ':' || COALESCE(native_session_id, '') AS generation
      FROM claude_request_observations r
    ),
    -- Later rows repeat a response's request (output updates, the settled
    -- result), so each response counts once, in the turn that first showed it.
    claude_turn_requests AS (
      SELECT
        thread_id,
        turn_id,
        MIN(generation) AS generation,
        MIN(native_session_id) AS native_session_id,
        SUM(cache_read_tokens) AS cache_read_tokens
      FROM (
        SELECT r.*,
          ROW_NUMBER() OVER (
            PARTITION BY r.thread_id, r.message_id ORDER BY r.created_at ASC
          ) AS response_rank
        FROM claude_request_source r
      )
      WHERE response_rank = 1 AND turn_id IS NOT NULL
      GROUP BY thread_id, turn_id
    ),
    claude_generation_starts AS (
      SELECT thread_id, native_session_id, generation, MIN(created_at) AS started_at
      FROM claude_request_source
      WHERE generation IS NOT NULL AND native_session_id IS NOT NULL
      GROUP BY thread_id, native_session_id, generation
    ),
    -- Claude Code restores a resumed session's saved usage totals into the
    -- first result of each new process, so that result's modelUsage spans
    -- earlier turns. Results written before Synara withheld it still carry it:
    -- find the first turn of every process that resumed an earlier one.
    claude_generation_turns AS (
      SELECT c.thread_id, c.turn_id, t.generation, t.native_session_id,
        MIN(c.created_at) AS completed_at
      FROM claude_completed_source c
      JOIN claude_turn_requests t ON t.thread_id = c.thread_id AND t.turn_id = c.turn_id
      WHERE t.generation IS NOT NULL AND t.native_session_id IS NOT NULL
      GROUP BY c.thread_id, c.turn_id, t.generation, t.native_session_id
    ),
    claude_resumed_first_turns AS (
      SELECT g.thread_id, g.turn_id
      FROM (
        SELECT thread_id, turn_id, generation, native_session_id,
          ROW_NUMBER() OVER (
            PARTITION BY thread_id, native_session_id, generation ORDER BY completed_at ASC, turn_id ASC
          ) AS generation_rank
        FROM claude_generation_turns
      ) g
      JOIN claude_generation_starts current_generation
        ON current_generation.thread_id = g.thread_id
       AND current_generation.native_session_id = g.native_session_id
       AND current_generation.generation = g.generation
      WHERE g.generation_rank = 1
        AND EXISTS (
          SELECT 1
          FROM claude_generation_starts earlier
          WHERE earlier.thread_id = current_generation.thread_id
            AND earlier.native_session_id = current_generation.native_session_id
            AND earlier.started_at < current_generation.started_at
        )
    ),
    -- A versioned result's modelUsage covers every request its process made
    -- since the previous result, subagents included. A withheld result (one
    -- that opened a resumed process) or an unusable breakdown still closes
    -- that span, but the parent does not count it.
    claude_settled_results AS (
      SELECT c.thread_id, c.activity_id, c.sequence, c.created_at, t.generation,
        ROW_NUMBER() OVER (
          PARTITION BY c.thread_id ORDER BY c.created_at, c.sequence, c.activity_id
        ) AS settlement_index,
        CASE WHEN resumed.turn_id IS NULL
          AND json_extract(c.payload_json, '$.tokenAccountingVersion') = 1
          AND json_type(c.payload_json, '$.modelUsage') = 'object'
          AND EXISTS (
            SELECT 1 FROM json_each(json_extract(c.payload_json, '$.modelUsage')) m
            WHERE m.type = 'object' AND ${modelUsageTokens(sql, "m.value")} > 0
          )
          THEN 1 ELSE 0
        END AS trusted
      FROM claude_completed_source c
      LEFT JOIN claude_turn_requests t ON t.thread_id = c.thread_id AND t.turn_id = c.turn_id
      LEFT JOIN claude_resumed_first_turns resumed
        ON resumed.thread_id = c.thread_id AND resumed.turn_id = c.turn_id
      -- Every actual result closes its span, even without trusted usage. Older
      -- completions without a marker are ambiguous; do not attribute their
      -- children to a later result. Explicitly resultless UI turns do not close it.
      WHERE json_extract(c.payload_json, '$.claudeResultObserved') IS NOT 0
    ),
    -- Assign the latest process preceding each child on an ordered timeline.
    -- Joining children to all previous process starts also grows quadratically
    -- for long histories with frequent restarts.
    claude_ordered_processes AS (
      SELECT thread_id, generation, started_at,
        ROW_NUMBER() OVER (
          PARTITION BY thread_id ORDER BY started_at, generation, native_session_id
        ) AS process_index
      FROM claude_generation_starts
    ),
    claude_process_timeline AS (
      SELECT thread_id, started_at AS created_at, NULL AS activity_id,
        0 AS is_child, process_index
      FROM claude_ordered_processes
      UNION ALL
      SELECT th.parent_thread_id, child.created_at, child.activity_id, 1, NULL
      FROM claude_completed_source child
      JOIN projection_threads th ON th.thread_id = child.thread_id
      WHERE th.creation_source = 'provider_native' AND th.parent_thread_id IS NOT NULL
    ),
    claude_process_assignments AS (
      SELECT *, MAX(process_index) OVER (
        PARTITION BY thread_id ORDER BY created_at, is_child, activity_id
        ROWS UNBOUNDED PRECEDING
      ) AS parent_process
      FROM claude_process_timeline
    ),
    claude_child_turns AS (
      SELECT child.activity_id, child.created_at, child.thread_id AS parent_thread_id,
        process.generation AS parent_generation
      FROM claude_process_assignments child
      LEFT JOIN claude_ordered_processes process
        ON process.thread_id = child.thread_id AND process.process_index = child.parent_process
      WHERE child.is_child = 1
    ),
    -- Merge children and results into one ordered timeline instead of joining
    -- every child to every future result. At equal timestamps a child precedes
    -- results; sequence and id retain the previous result tie-breaking order.
    claude_settlement_timeline AS (
      SELECT parent_thread_id AS thread_id, activity_id, created_at,
        NULL AS sequence, 0 AS is_result, NULL AS settlement_index, parent_generation
      FROM claude_child_turns
      UNION ALL
      SELECT thread_id, activity_id, created_at, sequence, 1, settlement_index, NULL
      FROM claude_settled_results
    ),
    claude_next_settlements AS (
      SELECT *, MIN(settlement_index) OVER (
        PARTITION BY thread_id ORDER BY created_at, is_result, sequence, activity_id
        ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING
      ) AS next_settlement
      FROM claude_settlement_timeline
    ),
    -- A subagent counts through its next parent result only when that result
    -- actually retained usage from the process in which the subagent ran.
    claude_children_in_parent AS (
      SELECT child.activity_id
      FROM claude_next_settlements child
      JOIN claude_settled_results settled
        ON settled.thread_id = child.thread_id
       AND settled.settlement_index = child.next_settlement
      WHERE child.is_result = 0 AND settled.trusted = 1
        AND (child.parent_generation IS NULL OR settled.generation IS NULL
          OR settled.generation = child.parent_generation)
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
      -- A subagent counts on its own only when no parent result counted it,
      -- e.g. after an interrupted, result-less, or withheld parent result.
      WHERE NOT EXISTS (
          SELECT 1 FROM claude_children_in_parent counted WHERE counted.activity_id = a.activity_id
        )
        ${tokenStatsThreadFilter(sql, sql.literal("a.thread_id"), scope)}
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
          AND resumed.turn_id IS NULL
          THEN json_extract(payload_json, '$.modelUsage') END AS models,
        CASE WHEN json_extract(payload_json, '$.tokenAccountingVersion') = 1
          AND json_type(payload_json, '$.mainLoopTokens') IN ('integer', 'real')
          AND json_extract(payload_json, '$.mainLoopTokens') >= 0
          THEN CAST(json_extract(payload_json, '$.mainLoopTokens') AS INTEGER)
          ELSE legacy.tokens
        END AS main_tokens,
        CASE WHEN json_extract(payload_json, '$.tokenAccountingVersion') = 1
          AND json_type(payload_json, '$.mainLoopCacheReadTokens') IN ('integer', 'real')
          AND json_extract(payload_json, '$.mainLoopCacheReadTokens') >= 0
          THEN CAST(json_extract(payload_json, '$.mainLoopCacheReadTokens') AS INTEGER)
        END AS main_cache_read_tokens,
        requests.cache_read_tokens AS request_cache_read_tokens
      FROM claude_completed_ranked c
      LEFT JOIN profile_stats_claude_legacy_usage legacy
        ON legacy.thread_id = c.thread_id AND legacy.turn_id = c.turn_id
      LEFT JOIN claude_resumed_first_turns resumed
        ON resumed.thread_id = c.thread_id AND resumed.turn_id = c.turn_id
      LEFT JOIN claude_turn_requests requests
        ON requests.thread_id = c.thread_id AND requests.turn_id = c.turn_id
      WHERE rank = 1
    ),
    claude_model_usage_entries AS (
      SELECT c.activity_id, c.thread_id, c.turn_id, c.created_at, c.dispatch_origin,
        c.model AS fallback_model,
        m.key AS model,
        CASE WHEN json_valid(m.value) THEN
          CASE WHEN json_type(m.value) = 'object' THEN m.value ELSE '{}' END
        ELSE '{}' END AS usage
      FROM claude_completed c, json_each(c.models) m
    ),
    claude_model_token_candidates AS (
      SELECT activity_id, thread_id, turn_id, created_at, dispatch_origin,
        COALESCE(NULLIF(TRIM(CAST(model AS TEXT)), ''), fallback_model) AS model,
        CAST(${modelUsageTokens(sql, "usage")} AS INTEGER) AS tokens,
        CAST(${jsonCount(sql, "usage", "$.cacheReadInputTokens")} AS INTEGER) AS cache_tokens
      FROM claude_model_usage_entries
    ),
    claude_model_token_rows AS (
      SELECT activity_id, thread_id, turn_id, created_at, dispatch_origin, model, tokens,
        MIN(tokens, cache_tokens) AS cache_tokens
      FROM claude_model_token_candidates
      WHERE tokens > 0
    ),
    -- cache_tokens is the part of tokens read from the prompt cache. A main
    -- loop without an exact result split retains only observed cache reads;
    -- output tokens must never inherit the prompt's cache ratio.
    claude_token_rows AS (
      SELECT thread_id, turn_id, created_at, dispatch_origin, model, tokens, cache_tokens
      FROM claude_model_token_rows
      UNION ALL
      SELECT c.thread_id, c.turn_id, c.created_at, c.dispatch_origin, c.model,
        CAST(c.main_tokens AS INTEGER) AS tokens,
        CAST(MIN(c.main_tokens, COALESCE(
          c.main_cache_read_tokens,
          c.request_cache_read_tokens,
          0
        )) AS INTEGER) AS cache_tokens
      FROM claude_completed c
      WHERE c.main_tokens > 0
        AND NOT EXISTS (
          SELECT 1 FROM claude_model_token_rows m WHERE m.activity_id = c.activity_id
        )
    )
  `;
}
