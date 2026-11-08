// Anonymous daily host counters reuse usage_turns; short-lived receipts admit updates once.
// New rows contain a fixed placeholder instead of installation/account/device identifiers.
import type { HostUsageWindow } from "@synara/contracts/hostUsage";
import { USAGE_TURN_CATEGORIES_SQL } from "./usagePrivacySql";

/** Atomically admit one fixed day, then add each dimension only for that admission. */
export async function storeHostUsage(db: D1Database, window: HostUsageWindow, receivedAt: string) {
  const attemptId = crypto.randomUUID(),
    day = window.windowStart.slice(0, 10);
  // Aggregates retain only the bucket boundary; precise arrival stays on short-lived receipts.
  const aggregateAt = window.windowEnd;
  const statements = [
    db
      .prepare(
        "INSERT OR IGNORE INTO host_usage_receipts (window_id,attempt_id,received_at) VALUES (?,?,?)",
      )
      .bind(window.windowId, attemptId, receivedAt),
  ];
  // Three category rows use 59 binds, below D1's 100-parameter ceiling.
  for (let offset = 0; offset < window.rows.length; offset += 3) {
    const rows = window.rows.slice(offset, offset + 3);
    const selects = rows
      .map(
        () => `SELECT 0 AS event_id,'aggregate' AS install_id,? AS day,'' AS app_version,'' AS platform,'' AS flavor,
      ? AS provider,? AS model,? AS effort,? AS interaction_mode,? AS runtime_mode,? AS origin,? AS outcome,
      ? AS turns,? AS duration_ms,? AS duration_samples,? AS input_tokens,? AS output_tokens,? AS cached_input_tokens,
      0 AS token_samples,? AS received_at,'product' AS source,? AS channel,? AS input_samples,? AS output_samples,? AS cached_input_samples`,
      )
      .join(" UNION ALL ");
    const binds = rows.flatMap((r) => [
      day,
      r.provider,
      r.model,
      r.effort,
      r.interactionMode,
      r.runtimeMode,
      r.origin,
      r.outcome,
      r.turns,
      r.durationMs,
      r.durationSamples,
      r.inputTokens,
      r.outputTokens,
      r.cachedInputTokens,
      aggregateAt,
      window.channel,
      r.inputSamples,
      r.outputSamples,
      r.cachedInputSamples,
    ]);
    statements.push(
      db
        .prepare(`INSERT INTO usage_turns
      (event_id,install_id,day,app_version,platform,flavor,provider,model,effort,interaction_mode,runtime_mode,origin,outcome,
      turns,duration_ms,duration_samples,input_tokens,output_tokens,cached_input_tokens,token_samples,received_at,source,channel,input_samples,output_samples,cached_input_samples)
      SELECT * FROM (${selects}) WHERE EXISTS (SELECT 1 FROM host_usage_receipts WHERE window_id = ? AND attempt_id = ?)
      ON CONFLICT (day,channel,provider,model,effort,interaction_mode,runtime_mode,origin,outcome) WHERE source = 'product' DO UPDATE SET
      turns=usage_turns.turns+excluded.turns,duration_ms=usage_turns.duration_ms+excluded.duration_ms,
      duration_samples=usage_turns.duration_samples+excluded.duration_samples,input_tokens=usage_turns.input_tokens+excluded.input_tokens,
      output_tokens=usage_turns.output_tokens+excluded.output_tokens,cached_input_tokens=usage_turns.cached_input_tokens+excluded.cached_input_tokens,
      input_samples=usage_turns.input_samples+excluded.input_samples,output_samples=usage_turns.output_samples+excluded.output_samples,
      cached_input_samples=usage_turns.cached_input_samples+excluded.cached_input_samples,received_at=excluded.received_at`)
        .bind(...binds, window.windowId, attemptId),
    );
  }
  statements.push(
    db
      .prepare(`INSERT INTO host_usage_daily_quality
    (day,channel,report_windows,partial_windows,eligible_turns,included_turns,missing_completion_times,token_truncated_turns,capped_measurements,received_at)
    SELECT ?,?,1,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM host_usage_receipts WHERE window_id = ? AND attempt_id = ?)
    ON CONFLICT (day,channel) DO UPDATE SET report_windows=host_usage_daily_quality.report_windows+excluded.report_windows,
    partial_windows=host_usage_daily_quality.partial_windows+excluded.partial_windows,eligible_turns=host_usage_daily_quality.eligible_turns+excluded.eligible_turns,
    included_turns=host_usage_daily_quality.included_turns+excluded.included_turns,missing_completion_times=host_usage_daily_quality.missing_completion_times+excluded.missing_completion_times,
    token_truncated_turns=host_usage_daily_quality.token_truncated_turns+excluded.token_truncated_turns,capped_measurements=host_usage_daily_quality.capped_measurements+excluded.capped_measurements,
    received_at=excluded.received_at`)
      .bind(
        day,
        window.channel,
        window.coveredFrom !== window.windowStart ? 1 : 0,
        window.eligibleTurns,
        window.includedTurns,
        window.missingCompletionTimes,
        window.tokenTruncatedTurns,
        window.cappedMeasurements,
        aggregateAt,
        window.windowId,
        attemptId,
      ),
  );
  await db.batch(statements);
}

/** Host observations and their field-specific coverage remain separate from renderer events. */
export async function readHostUsage(
  db: D1Database,
  from: string,
  to: string,
  channel: string | null,
) {
  const scope = channel ? " AND channel = ?" : "",
    binds = channel ? [from, to, channel] : [from, to];
  const [turns, coverage] = await Promise.all([
    db
      .prepare(`WITH categorized AS (SELECT turns,outcome,duration_ms,duration_samples,input_tokens,output_tokens,cached_input_tokens,
      input_samples,output_samples,cached_input_samples,${USAGE_TURN_CATEGORIES_SQL}
      FROM usage_turns WHERE source='product' AND day>=? AND day<=?${scope})
      SELECT provider,model,effort,interaction_mode AS interactionMode,runtime_mode AS runtimeMode,origin,SUM(turns) AS turns,
      SUM(CASE WHEN outcome='succeeded' THEN turns ELSE 0 END) AS succeeded,SUM(CASE WHEN outcome='failed' THEN turns ELSE 0 END) AS failed,
      SUM(CASE WHEN outcome='cancelled' THEN turns ELSE 0 END) AS cancelled,SUM(duration_ms) AS durationMs,SUM(duration_samples) AS durationSamples,
      SUM(input_tokens) AS inputTokens,SUM(input_samples) AS inputSamples,SUM(output_tokens) AS outputTokens,SUM(output_samples) AS outputSamples,
      SUM(cached_input_tokens) AS cachedInputTokens,SUM(cached_input_samples) AS cachedInputSamples
      FROM categorized GROUP BY provider,model,effort,interaction_mode,runtime_mode,origin ORDER BY turns DESC`)
      .bind(...binds)
      .all<Record<string, string | number>>(),
    db
      .prepare(`SELECT COALESCE(SUM(report_windows),0) AS reportWindows,COALESCE(SUM(partial_windows),0) AS partialWindows,
      COALESCE(SUM(eligible_turns),0) AS eligibleTurns,COALESCE(SUM(included_turns),0) AS includedTurns,
      COALESCE(SUM(missing_completion_times),0) AS missingCompletionTimes,COALESCE(SUM(token_truncated_turns),0) AS tokenTruncatedTurns,
      COALESCE(SUM(capped_measurements),0) AS cappedMeasurements FROM host_usage_daily_quality WHERE day>=? AND day<=?${scope}`)
      .bind(...binds)
      .first<Record<string, number>>(),
  ]);
  return {
    coverage,
    rows: turns.results.map((r) => ({
      ...r,
      inputTokens: Number(r.inputSamples) > 0 ? Number(r.inputTokens) : null,
      outputTokens: Number(r.outputSamples) > 0 ? Number(r.outputTokens) : null,
      cachedInputTokens: Number(r.cachedInputSamples) > 0 ? Number(r.cachedInputTokens) : null,
      meanDurationMs:
        Number(r.durationSamples) > 0
          ? Math.round(Number(r.durationMs) / Number(r.durationSamples))
          : null,
      meanInputTokens:
        Number(r.inputSamples) > 0
          ? Math.round(Number(r.inputTokens) / Number(r.inputSamples))
          : null,
      meanOutputTokens:
        Number(r.outputSamples) > 0
          ? Math.round(Number(r.outputTokens) / Number(r.outputSamples))
          : null,
    })),
  };
}
