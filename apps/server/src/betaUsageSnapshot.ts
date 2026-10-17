// FILE: betaUsageSnapshot.ts
// Purpose: Computes the anonymous last-24h usage snapshot for Synara Beta and Remote.
// Layer: Server maintenance task — runs only on Beta and Remote desktop builds.
//
// The desktop main process cannot reach the projection database, so the server
// writes counts to <betaHome>/diagnostics/usage-snapshot.json and the main
// process relays them as one `usage.daily` diagnostics event per UTC day.
// Only counts and fixed categories are written: provider, catalogued model name,
// effort, interaction/permission mode, origin and outcome. Never thread titles,
// paths, prompts, or provider payloads.

import { MODEL_CAPABILITIES_INDEX, ProviderKind } from "@synara/contracts";
import { normalizeModelSlug, stripClaudeContextWindowSuffix } from "@synara/shared/model";
import { Effect, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { writeFileStringAtomically } from "./atomicWrite";

export const BETA_USAGE_SNAPSHOT_FILE_NAME = "usage-snapshot.json";
export const BETA_USAGE_SNAPSHOT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BETA_USAGE_SNAPSHOT_WINDOW_MS = 24 * 60 * 60 * 1000;

// Terminal failure states from ProjectionTurnState ("pending" | "running" |
// "interrupted" | "completed" | "error"). An in-flight turn is not a failure,
// and "interrupted" is a user cancel, not an error.
const FAILED_TURN_STATES = ["error"] as const;

interface ProviderUsageRow {
  readonly provider: string;
  readonly threads: number;
  readonly turns: number;
  readonly turnsFailed: number | null;
}

interface CountRow {
  readonly n: number;
}

interface TurnRow {
  readonly state: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly interactionMode: string | null;
  readonly runtimeMode: string | null;
  readonly origin: string | null;
  readonly durationMs: number | null;
  readonly usage: string | null;
}

/** One aggregate row of the last 24h; every field is a fixed category or a count. */
export interface TurnBreakdownRow {
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly interactionMode: string;
  readonly runtimeMode: string;
  readonly origin: string;
  readonly outcome: "succeeded" | "failed" | "cancelled";
  turns: number;
  durationMs: number;
  durationSamples: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  tokenSamples: number;
}

const TURN_BREAKDOWN_MAX_TURNS = 5_000;
const TURN_BREAKDOWN_MAX_ROWS = 200;
const EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultrathink",
  "ultracode",
]);
const INTERACTION_MODES = new Set(["default", "plan", "debug"]);
const RUNTIME_MODES = new Set(["approval-required", "auto", "full-access"]);
const ORIGINS = new Set(["user", "automation", "agent"]);
const PROVIDERS = new Set<string>(ProviderKind.literals);
// Public model families keep their name when newer than the bundled catalog.
const PUBLIC_MODEL_PATTERN =
  /^(claude|gpt|o[0-9]|gemini|grok|kimi|qwen|deepseek|glm|codex|devin|composer)[a-z0-9.-]{0,40}$/;

/** A catalogued or public model name; anything a user could have named stays "other". */
export function usageModelCategory(provider: string, model: string | null): string {
  if (!model || !PROVIDERS.has(provider)) return "other";
  const slug = normalizeModelSlug(model, provider as ProviderKind) ?? model.trim();
  const base = stripClaudeContextWindowSuffix(slug).toLowerCase();
  if (MODEL_CAPABILITIES_INDEX[provider as ProviderKind]?.[base]) return base;
  return PUBLIC_MODEL_PATTERN.test(base) ? base : "other";
}

const OUTCOME_BY_STATE: Record<string, TurnBreakdownRow["outcome"]> = {
  completed: "succeeded",
  error: "failed",
  interrupted: "cancelled",
};

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Sums main-turn token counters; model keys can be user-defined and are never kept. */
function usageTokens(raw: string | null) {
  if (!raw) return null;
  try {
    const usage = JSON.parse(raw) as unknown;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
    const totals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    for (const entry of Object.values(usage).slice(0, 64)) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      totals.inputTokens += count(row.inputTokens);
      totals.outputTokens += count(row.outputTokens);
      totals.cachedInputTokens += count(row.cacheReadInputTokens);
    }
    return totals;
  } catch {
    return null;
  }
}

/** Finished turns of the last 24h, grouped by their fixed categories. */
export function aggregateTurnBreakdown(rows: ReadonlyArray<TurnRow>): TurnBreakdownRow[] {
  const groups = new Map<string, TurnBreakdownRow>();
  for (const row of rows) {
    const outcome = OUTCOME_BY_STATE[row.state];
    if (!outcome) continue;
    const provider = row.provider && PROVIDERS.has(row.provider) ? row.provider : "other";
    const category = {
      provider,
      model: usageModelCategory(provider, row.model),
      effort: row.effort && EFFORTS.has(row.effort) ? row.effort : "default",
      interactionMode:
        row.interactionMode && INTERACTION_MODES.has(row.interactionMode)
          ? row.interactionMode
          : "default",
      runtimeMode:
        row.runtimeMode && RUNTIME_MODES.has(row.runtimeMode) ? row.runtimeMode : "full-access",
      origin: row.origin && ORIGINS.has(row.origin) ? row.origin : "user",
      outcome,
    };
    const key = Object.values(category).join("|");
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= TURN_BREAKDOWN_MAX_ROWS) continue;
      group = {
        ...category,
        turns: 0,
        durationMs: 0,
        durationSamples: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        tokenSamples: 0,
      };
      groups.set(key, group);
    }
    group.turns += 1;
    if (row.durationMs !== null && Number.isFinite(row.durationMs) && row.durationMs >= 0) {
      group.durationMs += Math.round(row.durationMs);
      group.durationSamples += 1;
    }
    const tokens = usageTokens(row.usage);
    if (tokens) {
      group.inputTokens += tokens.inputTokens;
      group.outputTokens += tokens.outputTokens;
      group.cachedInputTokens += tokens.cachedInputTokens;
      group.tokenSamples += 1;
    }
  }
  return [...groups.values()];
}

/** Writes one snapshot. Fails the returned Effect on error; callers catch. */
export const writeBetaUsageSnapshot = (betaHomeDir: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const path = yield* Path.Path;
    const since = new Date(Date.now() - BETA_USAGE_SNAPSHOT_WINDOW_MS).toISOString();

    const providers = yield* sql<ProviderUsageRow>`
      SELECT s.provider_name AS provider, COUNT(DISTINCT t.thread_id) AS threads,
             COUNT(*) AS turns,
             SUM(CASE WHEN t.state IN ${sql.in(FAILED_TURN_STATES)} THEN 1 ELSE 0 END) AS turnsFailed
      FROM projection_turns t
      JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
      WHERE t.requested_at >= ${since} AND s.provider_name IS NOT NULL
      GROUP BY s.provider_name
    `;
    const projects = yield* sql<CountRow>`
      SELECT COUNT(*) AS n FROM projection_projects WHERE deleted_at IS NULL
    `;
    const activeThreads = yield* sql<CountRow>`
      SELECT COUNT(DISTINCT thread_id) AS n FROM projection_turns WHERE requested_at >= ${since}
    `;
    // The request event carries the turn's settings; the completion activity its usage.
    const turns = yield* sql<TurnRow>`
      SELECT t.state AS state,
             COALESCE(json_extract(e.payload_json, '$.modelSelection.provider'), s.provider_name)
               AS provider,
             json_extract(e.payload_json, '$.modelSelection.model') AS model,
             COALESCE(json_extract(e.payload_json, '$.modelSelection.options.effort'),
                      json_extract(e.payload_json, '$.modelSelection.options.reasoningEffort'))
               AS effort,
             json_extract(e.payload_json, '$.interactionMode') AS interactionMode,
             json_extract(e.payload_json, '$.runtimeMode') AS runtimeMode,
             json_extract(e.payload_json, '$.dispatchOrigin') AS origin,
             CASE WHEN t.started_at IS NOT NULL AND t.completed_at IS NOT NULL
                  THEN (julianday(t.completed_at) - julianday(t.started_at)) * 86400000 END
               AS durationMs,
             (SELECT json_extract(a.payload_json, '$.modelUsage') FROM projection_thread_activities a
               WHERE a.kind = 'turn.completed' AND a.thread_id = t.thread_id AND a.turn_id = t.turn_id
               LIMIT 1) AS usage
      FROM projection_turns t
      LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
      LEFT JOIN orchestration_events e
        ON e.event_type = 'thread.turn-start-requested' AND e.stream_id = t.thread_id
       AND json_extract(e.payload_json, '$.messageId') = t.pending_message_id
      WHERE t.requested_at >= ${since}
      LIMIT ${TURN_BREAKDOWN_MAX_TURNS}
    `;

    const snapshot = {
      v: 1,
      generatedAt: new Date().toISOString(),
      providers: providers.map((row) => ({
        provider: row.provider,
        threads: Number(row.threads),
        turns: Number(row.turns),
        turnsFailed: Number(row.turnsFailed ?? 0),
      })),
      projects: Number(projects[0]?.n ?? 0),
      activeThreads: Number(activeThreads[0]?.n ?? 0),
      turnBreakdown: aggregateTurnBreakdown(turns),
    };
    yield* writeFileStringAtomically({
      filePath: path.join(betaHomeDir, "diagnostics", BETA_USAGE_SNAPSHOT_FILE_NAME),
      contents: `${JSON.stringify(snapshot)}\n`,
    });
  });

/**
 * Snapshot at call time, then every 6h. Each write failure is logged and the
 * loop keeps going — diagnostics must never affect server startup or uptime.
 */
export const startBetaUsageSnapshotJob = (betaHomeDir: string) =>
  Effect.gen(function* () {
    while (true) {
      yield* writeBetaUsageSnapshot(betaHomeDir).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("beta usage snapshot write failed").pipe(
            Effect.annotateLogs({ cause: String(cause) }),
          ),
        ),
      );
      yield* Effect.sleep(BETA_USAGE_SNAPSHOT_INTERVAL_MS);
    }
  }).pipe(Effect.forkScoped);
