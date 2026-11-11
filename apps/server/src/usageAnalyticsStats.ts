// FILE: usageAnalyticsStats.ts
// Purpose: Usage analytics for Settings → Usage → Analytics from Synara's local
// projection DB: token deltas, turns, and cost at API rates as UTC-hour rows by
// provider, model, project, and origin. Cost is the provider's own figure when it
// reports one (Claude's SDK, Cursor, OpenCode); otherwise (Codex) the tokens are
// priced at API list prices (usagePricing.ts). The client buckets the rows into
// its own local days and hours. Shares the token SQL with profileStats.ts and the
// model naming with recapStats.ts. Available in Stable and Beta.
// Layer: server stats query service (SqlClient).

import {
  type ProviderKind,
  STATS_USAGE_ANALYTICS_MAX_WINDOW_MS,
  type StatsGetUsageAnalyticsInput,
  type StatsGetUsageAnalyticsResult,
  type StatsUsageAnalyticsCostRow,
  type StatsUsageAnalyticsOrigin,
  type StatsUsageAnalyticsProject,
  type StatsUsageAnalyticsTokenRow,
  type StatsUsageAnalyticsTurnRow,
  WsRpcError,
} from "@synara/contracts";
import { Effect, Layer, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  nonEmptyString,
  normalizeProviderKind,
  num,
  tokenDeltaCtes,
  turnModelSelectionCte,
} from "./profileStats";
import { recapModelName } from "./recapStats";
import { ServerConfig } from "./config";
import {
  makeUsagePricingSource,
  type PriceTable,
  priceTokens,
  type UsagePricingSource,
} from "./usagePricing";

const DAY_MS = 86_400_000;

interface AnalyticsWindow {
  readonly from: string;
  readonly to: string;
}

interface TokenHourRow {
  readonly hour: string | null;
  readonly origin: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly projectId: string | null;
  readonly title: string | null;
  readonly tokens: number;
  readonly cacheTokens: number;
  /** Tokens whose output part is known, and that part's cache reads. */
  readonly splitTokens: number;
  readonly splitCacheTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
}

interface TurnHourRow {
  readonly hour: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly projectId: string | null;
  readonly title: string | null;
  readonly turns: number;
  readonly failedTurns: number;
  readonly completedTurns: number;
}

interface CostHourRow {
  readonly hour: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly projectId: string | null;
  readonly title: string | null;
  readonly costUsd: number;
  readonly turns: number;
}

// ── Pure helpers ───────────────────────────────────────────────────────

/** The window as canonical ISO instants, or why it is refused. */
export function resolveUsageAnalyticsWindow(
  input: StatsGetUsageAnalyticsInput,
): AnalyticsWindow | { readonly error: string } {
  const fromMs = Date.parse(input.from);
  const toMs = Date.parse(input.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    return { error: "The analytics window must start before it ends." };
  }
  if (toMs - fromMs > STATS_USAGE_ANALYTICS_MAX_WINDOW_MS) {
    return {
      error: `The analytics window can span at most ${STATS_USAGE_ANALYTICS_MAX_WINDOW_MS / DAY_MS} days.`,
    };
  }
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

function analyticsOrigin(value: string | null): StatsUsageAnalyticsOrigin {
  return value === "automation" || value === "agent" ? value : "user";
}

/** `YYYY-MM-DDTHH` (SQL `substr(created_at, 1, 13)`) to the hour's start instant. */
function hourInstant(value: string | null): string | null {
  const hour = nonEmptyString(value);
  if (!hour || !/^\d{4}-\d{2}-\d{2}T\d{2}$/u.test(hour)) return null;
  return `${hour}:00:00.000Z`;
}

/** Sums rows that land on the same key once provider and model names are normalized. */
function mergeInto<Row>(
  map: Map<string, Row>,
  key: string,
  row: Row,
  merge: (existing: Row, next: Row) => void,
): void {
  const existing = map.get(key);
  if (existing) merge(existing, row);
  else map.set(key, row);
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * API list-price cost of one token row. Only tokens with a known output part
 * are priced: without it, output (the dearest part) would be priced as input.
 */
export function estimateCost(
  prices: PriceTable,
  model: string,
  total: number,
  row: Pick<TokenHourRow, "splitTokens" | "splitCacheTokens" | "outputTokens" | "cacheWriteTokens">,
): { readonly costUsd: number; readonly unpricedTokens: number } {
  const split = Math.min(total, Math.max(0, Math.round(num(row.splitTokens))));
  const cacheRead = Math.min(split, Math.max(0, Math.round(num(row.splitCacheTokens))));
  const output = Math.min(split - cacheRead, Math.max(0, Math.round(num(row.outputTokens))));
  const cacheWrite = Math.min(
    split - cacheRead - output,
    Math.max(0, Math.round(num(row.cacheWriteTokens))),
  );
  const costUsd =
    split > 0
      ? priceTokens(prices.table, model, {
          inputTokens: split - cacheRead - output - cacheWrite,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          outputTokens: output,
        })
      : null;
  return costUsd === null
    ? { costUsd: 0, unpricedTokens: total }
    : { costUsd, unpricedTokens: total - split };
}

export function buildUsageAnalytics(input: {
  readonly window: AnalyticsWindow;
  readonly tokenRows: ReadonlyArray<TokenHourRow>;
  readonly turnRows: ReadonlyArray<TurnHourRow>;
  readonly costRows: ReadonlyArray<CostHourRow>;
  readonly prices: PriceTable;
  readonly nowMs: number;
}): StatsGetUsageAnalyticsResult {
  const projects = new Map<string, StatsUsageAnalyticsProject>();
  const projectFor = (projectId: string | null, title: string | null): string | null => {
    const id = nonEmptyString(projectId);
    const name = nonEmptyString(title);
    if (!id || !name) return null;
    if (!projects.has(id)) projects.set(id, { projectId: id, title: name });
    return id;
  };
  const identity = (provider: string | null, model: string | null) => {
    const normalizedProvider = normalizeProviderKind(provider);
    return { provider: normalizedProvider, model: recapModelName(normalizedProvider, model) };
  };

  const costs = new Map<string, Mutable<StatsUsageAnalyticsCostRow>>();
  const addCost = (row: StatsUsageAnalyticsCostRow) =>
    mergeInto(
      costs,
      [row.hour, row.provider, row.model, row.projectId ?? "", row.source].join("\u0000"),
      { ...row },
      (existing, next) => {
        existing.costUsd += next.costUsd;
        existing.turns += next.turns;
      },
    );

  // A provider that reports its own cost keeps it. Pricing its tokens as well
  // would count that usage twice.
  const reportingProviders = new Set<string>();
  for (const row of input.costRows) {
    if (num(row.costUsd) > 0) reportingProviders.add(normalizeProviderKind(row.provider));
  }
  const unpricedModels = new Set<string>();
  let unpricedTokens = 0;

  const tokens = new Map<string, Mutable<StatsUsageAnalyticsTokenRow>>();
  const providersWithTokens = new Set<ProviderKind>();
  for (const row of input.tokenRows) {
    const hour = hourInstant(row.hour);
    const total = Math.round(num(row.tokens));
    if (!hour || total <= 0) continue;
    const { provider, model } = identity(row.provider, row.model);
    if (provider !== "unknown") providersWithTokens.add(provider);
    const projectId = projectFor(row.projectId, row.title);
    const origin = analyticsOrigin(row.origin);
    if (!reportingProviders.has(provider)) {
      const estimate = estimateCost(input.prices, model, total, row);
      if (estimate.costUsd > 0) {
        addCost({
          hour,
          provider,
          model,
          projectId,
          source: "estimated",
          costUsd: estimate.costUsd,
          turns: 0,
        });
      }
      if (estimate.unpricedTokens > 0) {
        unpricedTokens += estimate.unpricedTokens;
        unpricedModels.add(model);
      }
    }
    mergeInto(
      tokens,
      [hour, provider, model, projectId ?? "", origin].join("\u0000"),
      {
        hour,
        provider,
        model,
        projectId,
        origin,
        tokens: total,
        cacheReadTokens: Math.min(total, Math.max(0, Math.round(num(row.cacheTokens)))),
      },
      (existing, next) => {
        existing.tokens += next.tokens;
        existing.cacheReadTokens += next.cacheReadTokens;
      },
    );
  }

  const turns = new Map<string, Mutable<StatsUsageAnalyticsTurnRow>>();
  const providersWithCompletedTurns = new Set<ProviderKind>();
  for (const row of input.turnRows) {
    const hour = hourInstant(row.hour);
    const count = Math.round(num(row.turns));
    if (!hour || count <= 0) continue;
    const { provider, model } = identity(row.provider, row.model);
    // Only a completed turn proves that a provider reports no usage: a running
    // turn has none yet, and one that failed early may never have emitted any.
    if (provider !== "unknown" && num(row.completedTurns) > 0) {
      providersWithCompletedTurns.add(provider);
    }
    const projectId = projectFor(row.projectId, row.title);
    mergeInto(
      turns,
      [hour, provider, model, projectId ?? ""].join("\u0000"),
      {
        hour,
        provider,
        model,
        projectId,
        turns: count,
        failedTurns: Math.min(count, Math.max(0, Math.round(num(row.failedTurns)))),
      },
      (existing, next) => {
        existing.turns += next.turns;
        existing.failedTurns += next.failedTurns;
      },
    );
  }

  for (const row of input.costRows) {
    const hour = hourInstant(row.hour);
    const costUsd = num(row.costUsd);
    if (!hour || !(costUsd > 0)) continue;
    const { provider, model } = identity(row.provider, row.model);
    const projectId = projectFor(row.projectId, row.title);
    addCost({
      hour,
      provider,
      model,
      projectId,
      source: "reported",
      costUsd,
      turns: Math.max(0, Math.round(num(row.turns))),
    });
  }

  return {
    generatedAt: new Date(input.nowMs).toISOString(),
    from: input.window.from,
    to: input.window.to,
    tokens: [...tokens.values()],
    turns: [...turns.values()],
    costs: [...costs.values()],
    pricing: {
      status: input.prices.status,
      fetchedAt: input.prices.fetchedAt,
      unpricedModels: [...unpricedModels].filter((model) => model !== "unknown").toSorted(),
      unpricedTokens,
    },
    projects: [...projects.values()].toSorted((left, right) =>
      left.title.localeCompare(right.title),
    ),
    unavailableProviders: [...providersWithCompletedTurns]
      .filter((provider) => !providersWithTokens.has(provider))
      .toSorted(),
  };
}

// ── Service ────────────────────────────────────────────────────────────

export interface UsageAnalyticsQueryShape {
  readonly getUsageAnalytics: (
    input: StatsGetUsageAnalyticsInput,
  ) => Effect.Effect<StatsGetUsageAnalyticsResult, unknown>;
}

export class UsageAnalyticsQuery extends ServiceMap.Service<
  UsageAnalyticsQuery,
  UsageAnalyticsQueryShape
>()("synara/usageAnalyticsStats/UsageAnalyticsQuery") {}

const NO_PRICES: UsagePricingSource = {
  load: async () => ({ table: new Map(), status: "unavailable", fetchedAt: null }),
};

export const makeUsageAnalyticsQuery = (
  options: { readonly now?: () => number; readonly pricing?: UsagePricingSource } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = options.now ?? Date.now;
    const pricing = options.pricing ?? NO_PRICES;

    // Same provider/model attribution as the recap's turns: the turn's selection
    // first, then the thread's current selection and session as fallbacks.
    const providerColumn = sql.literal(`
      COALESCE(
        tm.provider,
        CASE WHEN tm.instanceId = s.provider_instance_id THEN s.provider_name ELSE tm.instanceId END,
        CASE WHEN json_valid(th.model_selection_json)
          THEN json_extract(th.model_selection_json, '$.provider') END,
        CASE WHEN json_valid(th.model_selection_json) THEN
          CASE
            WHEN json_extract(th.model_selection_json, '$.instanceId') = s.provider_instance_id
            THEN s.provider_name
            ELSE json_extract(th.model_selection_json, '$.instanceId')
          END
        END,
        s.provider_name
      )
    `);
    const modelColumn = sql.literal(`
      COALESCE(
        tm.model,
        CASE WHEN json_valid(th.model_selection_json)
          THEN json_extract(th.model_selection_json, '$.model') END
      )
    `);
    // Only real projects get a row; per-chat and Studio containers do not rank.
    const realProjectJoin = (projectIdColumn: string) =>
      sql.literal(`
        LEFT JOIN projection_projects p
          ON p.project_id = ${projectIdColumn}
         AND p.kind = 'project'
         AND p.deleted_at IS NULL
      `);

    // Deltas need each thread's full history (see tokenDeltaCtes), so the scope is
    // every thread with token activity in the window and the time filter applies to
    // the computed delta rows. Purged threads count from the deletion archive.
    const queryTokens = (window: AnalyticsWindow) => sql<TokenHourRow>`
      WITH analytics_threads AS (
        SELECT DISTINCT thread_id
        FROM projection_thread_activities
        WHERE kind IN ('context-window.updated', 'turn.completed')
          AND created_at >= ${window.from}
          AND created_at < ${window.to}
      ),
      ${tokenDeltaCtes(sql, { threadIdsQuery: sql`SELECT thread_id FROM analytics_threads` })},
      analytics_token_rows AS (
        SELECT
          r.created_at AS created_at,
          r.dispatch_origin AS origin,
          r.provider AS provider,
          r.model AS model,
          t.project_id AS project_id,
          r.tokens AS tokens,
          r.cache_tokens AS cache_tokens,
          r.output_tokens AS output_tokens,
          r.cache_write_tokens AS cache_write_tokens
        FROM token_delta_rows r
        JOIN projection_threads t ON t.thread_id = r.thread_id
        WHERE r.created_at >= ${window.from} AND r.created_at < ${window.to}
        UNION ALL
        -- The deletion archive keeps totals only, so its cache share is unknown.
        SELECT
          d.created_at,
          'user',
          COALESCE(d.provider, 'unknown'),
          COALESCE(d.model, 'unknown'),
          dt.project_id,
          d.tokens,
          0,
          NULL,
          NULL
        FROM profile_stats_deleted_tokens d
        LEFT JOIN profile_stats_deleted_threads dt ON dt.thread_id = d.thread_id
        WHERE d.created_at >= ${window.from}
          AND d.created_at < ${window.to}
          AND (COALESCE(d.provider, 'unknown') != 'claudeAgent' OR d.token_accounting_version = 1)
      )
      SELECT
        substr(r.created_at, 1, 13) AS hour,
        r.origin AS origin,
        r.provider AS provider,
        r.model AS model,
        p.project_id AS projectId,
        p.title AS title,
        SUM(r.tokens) AS tokens,
        SUM(r.cache_tokens) AS cacheTokens,
        SUM(CASE WHEN r.output_tokens IS NOT NULL THEN r.tokens ELSE 0 END) AS splitTokens,
        SUM(CASE WHEN r.output_tokens IS NOT NULL THEN r.cache_tokens ELSE 0 END)
          AS splitCacheTokens,
        SUM(COALESCE(r.output_tokens, 0)) AS outputTokens,
        SUM(CASE WHEN r.output_tokens IS NOT NULL THEN COALESCE(r.cache_write_tokens, 0) ELSE 0 END)
          AS cacheWriteTokens
      FROM analytics_token_rows r
      ${realProjectJoin("r.project_id")}
      GROUP BY hour, r.origin, r.provider, r.model, p.project_id, p.title
    `;

    // Turns requested in the window. Subagent (provider-native child) threads are
    // left out: their parent turn already covers that work.
    const queryTurns = (window: AnalyticsWindow) => sql<TurnHourRow>`
      WITH turn_model AS (
        ${turnModelSelectionCte(sql, {
          threadIdsQuery: sql`
            SELECT scoped.thread_id
            FROM projection_turns scoped
            WHERE scoped.turn_id IS NOT NULL
              AND scoped.requested_at >= ${window.from}
              AND scoped.requested_at < ${window.to}
          `,
        })}
      )
      -- Attribute first, then group: grouping by an alias that shares a name with a
      -- joined column would group by that column instead.
      SELECT
        hour,
        provider,
        model,
        projectId,
        title,
        COUNT(*) AS turns,
        SUM(CASE WHEN state = 'error' THEN 1 ELSE 0 END) AS failedTurns,
        SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) AS completedTurns
      FROM (
        SELECT
          substr(pt.requested_at, 1, 13) AS hour,
          ${providerColumn} AS provider,
          ${modelColumn} AS model,
          p.project_id AS projectId,
          p.title AS title,
          pt.state AS state
        FROM projection_turns pt
        JOIN projection_threads th ON th.thread_id = pt.thread_id
        LEFT JOIN turn_model tm ON tm.thread_id = pt.thread_id AND tm.turn_id = pt.turn_id
        LEFT JOIN projection_thread_sessions s ON s.thread_id = pt.thread_id
        ${realProjectJoin("th.project_id")}
        WHERE pt.turn_id IS NOT NULL
          AND pt.requested_at >= ${window.from}
          AND pt.requested_at < ${window.to}
          AND COALESCE(th.creation_source, '') != 'provider_native'
      )
      GROUP BY hour, provider, model, projectId, title
    `;

    // Cost the provider reported when a turn completed: `totalCostUsd` is that
    // turn's cost; `cumulativeCostUsd` (Cursor, ACP) is a running session total, so
    // each turn costs its increase over the thread's previous total (a drop means a
    // new session, which starts from zero).
    const queryCosts = (window: AnalyticsWindow) => sql<CostHourRow>`
      WITH cost_threads AS (
        SELECT DISTINCT thread_id
        FROM projection_thread_activities
        WHERE kind = 'turn.completed'
          AND created_at >= ${window.from}
          AND created_at < ${window.to}
      ),
      turn_model AS (
        ${turnModelSelectionCte(sql, { threadIdsQuery: sql`SELECT thread_id FROM cost_threads` })}
      ),
      completed AS (
        SELECT
          a.thread_id AS thread_id,
          a.turn_id AS turn_id,
          a.created_at AS created_at,
          a.sequence AS sequence,
          a.activity_id AS activity_id,
          CASE WHEN json_valid(a.payload_json)
            THEN json_extract(a.payload_json, '$.totalCostUsd') END AS turn_cost,
          CASE WHEN json_valid(a.payload_json)
            THEN json_extract(a.payload_json, '$.cumulativeCostUsd') END AS cumulative_cost
        FROM projection_thread_activities a
        WHERE a.kind = 'turn.completed'
          AND a.thread_id IN (SELECT thread_id FROM cost_threads)
      ),
      cumulative AS (
        SELECT
          thread_id,
          turn_id,
          created_at,
          cumulative_cost,
          LAG(cumulative_cost) OVER (
            PARTITION BY thread_id
            ORDER BY
              CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
              sequence ASC,
              created_at ASC,
              activity_id ASC
          ) AS previous_cost
        FROM completed
        WHERE typeof(cumulative_cost) IN ('integer', 'real')
      ),
      cost_rows AS (
        SELECT thread_id, turn_id, created_at, turn_cost AS cost
        FROM completed
        WHERE typeof(cumulative_cost) NOT IN ('integer', 'real')
          AND typeof(turn_cost) IN ('integer', 'real')
        UNION ALL
        SELECT
          thread_id,
          turn_id,
          created_at,
          CASE
            WHEN previous_cost IS NULL OR cumulative_cost < previous_cost THEN cumulative_cost
            ELSE cumulative_cost - previous_cost
          END
        FROM cumulative
      )
      SELECT
        hour,
        provider,
        model,
        projectId,
        title,
        SUM(CASE WHEN cost > 0 THEN cost ELSE 0 END) AS costUsd,
        SUM(CASE WHEN cost > 0 THEN 1 ELSE 0 END) AS turns
      FROM (
        SELECT
          substr(c.created_at, 1, 13) AS hour,
          ${providerColumn} AS provider,
          ${modelColumn} AS model,
          p.project_id AS projectId,
          p.title AS title,
          c.cost AS cost
        FROM cost_rows c
        JOIN projection_threads th ON th.thread_id = c.thread_id
        LEFT JOIN turn_model tm ON tm.thread_id = c.thread_id AND tm.turn_id = c.turn_id
        LEFT JOIN projection_thread_sessions s ON s.thread_id = c.thread_id
        ${realProjectJoin("th.project_id")}
        WHERE c.created_at >= ${window.from} AND c.created_at < ${window.to}
      )
      GROUP BY hour, provider, model, projectId, title
    `;

    const getUsageAnalytics: UsageAnalyticsQueryShape["getUsageAnalytics"] = (input) =>
      Effect.gen(function* () {
        const window = resolveUsageAnalyticsWindow(input);
        if ("error" in window) {
          return yield* Effect.fail(
            new WsRpcError({ message: window.error, code: "INVALID_INPUT", retryable: false }),
          );
        }
        // One transaction so every part reads the same snapshot.
        const rows = yield* sql.withTransaction(
          Effect.all({
            tokenRows: queryTokens(window),
            turnRows: queryTurns(window),
            costRows: queryCosts(window),
          }),
        );
        const prices = yield* Effect.promise(() => pricing.load());
        return buildUsageAnalytics({ window, ...rows, prices, nowMs: now() });
      });

    return { getUsageAnalytics } satisfies UsageAnalyticsQueryShape;
  });

export const UsageAnalyticsQueryLive = Layer.effect(
  UsageAnalyticsQuery,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return yield* makeUsageAnalyticsQuery({
      pricing: makeUsagePricingSource({ stateDir: config.stateDir }),
    });
  }),
);
