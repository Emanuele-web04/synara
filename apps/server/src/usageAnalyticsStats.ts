// FILE: usageAnalyticsStats.ts
// Purpose: Usage analytics for Settings → Usage → Analytics from Synara's local
// projection DB: token deltas, turns, and cost at API rates as UTC-hour rows by
// provider, model, project, and origin. Cost is the provider's own figure when it
// reports one (Claude's SDK, Cursor, OpenCode); otherwise (Codex) the tokens are
// priced at API list prices (usagePricing.ts). The "This Mac" scope reads Claude
// Code and Codex from their own session files instead (transcriptUsage.ts), so
// sessions run outside Synara count too. The client buckets the rows into its
// own local days and hours. Shares the token SQL with profileStats.ts and the
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
  type StatsUsageAnalyticsScope,
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
import nodePath from "node:path";

import { recapModelName } from "./recapStats";
import { ServerConfig } from "./config";
import {
  defaultTranscriptRoots,
  makeTranscriptUsageReader,
  type TranscriptScan,
  type TranscriptUsageReader,
} from "./transcriptUsage";
import { transcriptTokenTotal } from "./transcriptUsageParsers";
import {
  makeUsagePricingSource,
  type PriceTable,
  priceTokens,
  priceTranscriptUsage,
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

/**
 * Rows are bucketed by UTC quarter hour: every time zone's offset is a multiple
 * of 15 minutes, so a client in UTC+5:30 can still split them at its own midnight.
 */
const QUARTER_HOUR = (column: string) =>
  `substr(${column}, 1, 14) || printf('%02d', (CAST(substr(${column}, 15, 2) AS INTEGER) / 15) * 15)`;

/** `YYYY-MM-DDTHH:MM` (see QUARTER_HOUR) to the quarter hour's start instant. */
function hourInstant(value: string | null): string | null {
  const slot = nonEmptyString(value);
  if (!slot || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(slot)) return null;
  return `${slot}:00.000Z`;
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
): { readonly costUsd: number; readonly unpricedTokens: number; readonly unsplitTokens: number } {
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
  return {
    costUsd: costUsd ?? 0,
    unpricedTokens: costUsd === null ? split : 0,
    unsplitTokens: total - split,
  };
}

/**
 * Providers that report their own cost keep it; pricing their tokens as well
 * would count that usage twice. Their tokens are never estimated.
 */
export function reportingProviders(costRows: ReadonlyArray<CostHourRow>): ReadonlySet<string> {
  const providers = new Set<string>();
  for (const row of costRows) {
    if (num(row.costUsd) > 0) providers.add(normalizeProviderKind(row.provider));
  }
  return providers;
}

/** Whether any token row needs the API price list. */
export function needsPrices(
  tokenRows: ReadonlyArray<TokenHourRow>,
  reporting: ReadonlySet<string>,
): boolean {
  return tokenRows.some(
    (row) => num(row.splitTokens) > 0 && !reporting.has(normalizeProviderKind(row.provider)),
  );
}

export function buildUsageAnalytics(input: {
  readonly window: AnalyticsWindow;
  readonly tokenRows: ReadonlyArray<TokenHourRow>;
  readonly turnRows: ReadonlyArray<TurnHourRow>;
  readonly costRows: ReadonlyArray<CostHourRow>;
  readonly prices: PriceTable;
  readonly nowMs: number;
  readonly scope?: StatsUsageAnalyticsScope;
  readonly sessionFiles?: ReturnType<typeof buildTranscriptRows>;
}): StatsGetUsageAnalyticsResult {
  const files = input.sessionFiles;
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

  const reporting = reportingProviders(input.costRows);
  // Providers read from session files are left out of Synara's rows, which
  // would count the same sessions again.
  const fromFiles = new Set<string>(files?.providers ?? []);

  const tokens = new Map<string, Mutable<StatsUsageAnalyticsTokenRow>>();
  const providersWithTokens = new Set<ProviderKind>();
  for (const row of input.tokenRows) {
    const hour = hourInstant(row.hour);
    const total = Math.round(num(row.tokens));
    if (!hour || total <= 0) continue;
    const { provider, model } = identity(row.provider, row.model);
    if (fromFiles.has(provider)) continue;
    if (provider !== "unknown") providersWithTokens.add(provider);
    const projectId = projectFor(row.projectId, row.title);
    const origin = analyticsOrigin(row.origin);
    const estimate = reporting.has(provider)
      ? { costUsd: 0, unpricedTokens: 0, unsplitTokens: 0 }
      : estimateCost(input.prices, model, total, row);
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
        unpricedTokens: estimate.unpricedTokens,
        unsplitTokens: estimate.unsplitTokens,
      },
      (existing, next) => {
        existing.tokens += next.tokens;
        existing.cacheReadTokens += next.cacheReadTokens;
        existing.unpricedTokens += next.unpricedTokens;
        existing.unsplitTokens += next.unsplitTokens;
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
    if (fromFiles.has(provider)) continue;
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
    if (fromFiles.has(provider)) continue;
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
    tokens: [...tokens.values(), ...(files?.tokens ?? [])],
    turns: [...turns.values(), ...(files?.turns ?? [])],
    costs: [...costs.values(), ...(files?.costs ?? [])],
    pricing: { status: input.prices.status, fetchedAt: input.prices.fetchedAt },
    scope: input.scope ?? "synara",
    sessionFileProviders: [...(files?.providers ?? [])].toSorted(),
    projects: [
      ...new Map(
        [...projects.values(), ...(files?.projects ?? [])].map((project) => [
          project.projectId,
          project,
        ]),
      ).values(),
    ].toSorted((left, right) => left.title.localeCompare(right.title)),
    unavailableProviders: [...providersWithCompletedTurns]
      .filter((provider) => !providersWithTokens.has(provider))
      .toSorted(),
  };
}

// ── Session files (the "This Mac" scope) ─────────────────────────────

/** A folder Synara knows: a real project (id and title) or a chat container (null). */
export interface ProjectRoot {
  readonly path: string;
  readonly project: StatsUsageAnalyticsProject | null;
}

/** A Claude Code worktree (`<repo>/.claude/worktrees/<name>`) counts as its repo. */
function repoDirectory(cwd: string): string {
  const marker = `${nodePath.sep}.claude${nodePath.sep}worktrees${nodePath.sep}`;
  const index = cwd.indexOf(marker);
  return index > 0 ? cwd.slice(0, index) : cwd;
}

/** The project a session's directory belongs to, else its own folder as a project. */
function projectForDirectory(
  cwd: string,
  roots: ReadonlyArray<ProjectRoot>,
): StatsUsageAnalyticsProject | null {
  if (!cwd) return null;
  let best: ProjectRoot | null = null;
  for (const root of roots) {
    // A chat container can sit at the home folder, so only its own folder is a chat.
    const inside =
      cwd === root.path || (root.project !== null && cwd.startsWith(`${root.path}${nodePath.sep}`));
    if (inside && (!best || root.path.length > best.path.length)) best = root;
  }
  if (best) return best.project;
  // Clones and worktrees of one repo share its folder name, so they count as one.
  const name = nodePath.basename(repoDirectory(cwd));
  return name ? { projectId: `folder:${name}`, title: name } : null;
}

/** Start of the UTC quarter hour, as the SQL rows use (see QUARTER_HOUR). */
function utcHour(timestampMs: number): string {
  const quarter = 15 * 60 * 1000;
  return new Date(Math.floor(timestampMs / quarter) * quarter).toISOString();
}

/**
 * Rows for the usage and turns in Claude Code's and Codex's own session files,
 * de-duplicated across files and priced per response.
 */
export function buildTranscriptRows(input: {
  readonly scan: TranscriptScan;
  readonly window: AnalyticsWindow;
  readonly prices: PriceTable;
  readonly projectRoots: ReadonlyArray<ProjectRoot>;
}) {
  const fromMs = Date.parse(input.window.from);
  const toMs = Date.parse(input.window.to);
  const seen = new Set<string>();
  const projects = new Map<string, StatsUsageAnalyticsProject>();
  const projectByCwd = new Map<string, StatsUsageAnalyticsProject | null>();
  const projectIdFor = (cwd: string): string | null => {
    let project = projectByCwd.get(cwd);
    if (project === undefined) {
      project = projectForDirectory(cwd, input.projectRoots);
      projectByCwd.set(cwd, project);
    }
    if (project && !projects.has(project.projectId)) projects.set(project.projectId, project);
    return project?.projectId ?? null;
  };
  const tokens = new Map<string, Mutable<StatsUsageAnalyticsTokenRow>>();
  const turns = new Map<string, Mutable<StatsUsageAnalyticsTurnRow>>();
  const costs = new Map<string, Mutable<StatsUsageAnalyticsCostRow>>();
  const turnRow = (
    hour: string,
    provider: ProviderKind,
    model: string,
    projectId: string | null,
  ) => {
    const key = [hour, provider, model, projectId ?? ""].join("\u0000");
    let row = turns.get(key);
    if (!row) {
      row = { hour, provider, model, projectId, turns: 0, failedTurns: 0 };
      turns.set(key, row);
    }
    return row;
  };

  for (const file of input.scan.files) {
    // A Claude prompt names no model; it takes the model of the response after it.
    let waiting: Array<{ hour: string; cwd: string }> = [];
    let lastModel = "unknown";
    const settle = (rawModel: string) => {
      const model = recapModelName("claudeAgent", rawModel);
      for (const turn of waiting)
        turnRow(turn.hour, "claudeAgent", model, projectIdFor(turn.cwd)).turns += 1;
      waiting = [];
    };
    for (const record of file) {
      if (record.dedupeKey !== null) {
        if (seen.has(record.dedupeKey)) continue;
        seen.add(record.dedupeKey);
      }
      if (record.kind === "usage" && record.model) lastModel = record.model;
      if (record.kind === "usage" && record.provider === "claudeAgent" && waiting.length > 0) {
        settle(record.model || lastModel);
      }
      if (record.timestampMs < fromMs || record.timestampMs >= toMs) continue;
      const hour = utcHour(record.timestampMs);
      if (record.kind === "turn") {
        if (record.provider === "claudeAgent") waiting.push({ hour, cwd: record.cwd });
        else
          turnRow(
            hour,
            record.provider,
            recapModelName(record.provider, record.model),
            projectIdFor(record.cwd),
          ).turns += 1;
        continue;
      }
      const model = recapModelName(record.provider, record.model);
      const projectId = projectIdFor(record.cwd);
      if (record.failed) {
        turnRow(hour, record.provider, model, projectId).failedTurns += 1;
        continue;
      }
      const total = transcriptTokenTotal(record.tokens);
      if (total <= 0) continue;
      const cost = priceTranscriptUsage(input.prices.table, record);
      const tokenKey = [hour, record.provider, model, projectId ?? ""].join("\u0000");
      const tokenRow = tokens.get(tokenKey) ?? {
        hour,
        provider: record.provider,
        model,
        projectId,
        origin: null,
        tokens: 0,
        cacheReadTokens: 0,
        unpricedTokens: 0,
        unsplitTokens: 0,
      };
      tokenRow.tokens += total;
      tokenRow.cacheReadTokens += record.tokens.cacheReadTokens;
      if (cost === null) tokenRow.unpricedTokens += total;
      tokens.set(tokenKey, tokenRow);
      if (cost !== null && cost > 0) {
        const source = record.reportedCostUsd === null ? "estimated" : "reported";
        const costKey = `${tokenKey}\u0000${source}`;
        const costRow = costs.get(costKey) ?? {
          hour,
          provider: record.provider,
          model,
          projectId,
          source,
          costUsd: 0,
          turns: 0,
        };
        costRow.costUsd += cost;
        costs.set(costKey, costRow);
      }
    }
    if (waiting.length > 0) settle(lastModel);
  }

  // An error can land in an hour whose prompt was in the hour before.
  for (const row of turns.values()) row.turns = Math.max(row.turns, row.failedTurns);
  // An empty or unreadable transcript directory cannot replace Synara's data.
  const providers = new Set<ProviderKind>();
  for (const rows of [tokens.values(), turns.values()]) {
    for (const row of rows) if (row.provider !== "unknown") providers.add(row.provider);
  }
  return {
    providers: [...providers].toSorted(),
    tokens: [...tokens.values()],
    turns: [...turns.values()],
    costs: [...costs.values()],
    projects: [...projects.values()],
  };
}

/** True when a session-file response needs the price list. */
function scanNeedsPrices(scan: TranscriptScan): boolean {
  return scan.files.some((file) =>
    file.some((record) => record.kind === "usage" && record.reportedCostUsd === null),
  );
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

const NOT_NEEDED: PriceTable = { table: new Map(), status: "unavailable", fetchedAt: null };
const NO_PRICES: UsagePricingSource = { load: async () => NOT_NEEDED };

const NO_SESSION_FILES: TranscriptUsageReader = {
  scan: async () => ({ files: [] }),
};

export const makeUsageAnalyticsQuery = (
  options: {
    readonly now?: () => number;
    readonly pricing?: UsagePricingSource;
    readonly sessionFiles?: TranscriptUsageReader;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = options.now ?? Date.now;
    const pricing = options.pricing ?? NO_PRICES;
    const sessionFiles = options.sessionFiles ?? NO_SESSION_FILES;

    // Folders Synara knows, to put session-file usage under its projects.
    const queryProjectRoots = () => sql<{
      readonly path: string | null;
      readonly projectId: string;
      readonly title: string | null;
      readonly kind: string | null;
    }>`
      SELECT p.workspace_root AS path, p.project_id AS projectId, p.title AS title, p.kind AS kind
      FROM projection_projects p
      WHERE p.deleted_at IS NULL
      UNION
      SELECT t.worktree_path, p.project_id, p.title, p.kind
      FROM projection_threads t
      JOIN projection_projects p ON p.project_id = t.project_id AND p.deleted_at IS NULL
      WHERE t.worktree_path IS NOT NULL
    `;

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
          r.cache_write_tokens AS cache_write_tokens,
          r.split_cache_tokens AS split_cache_tokens
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
          NULL,
          NULL
        FROM profile_stats_deleted_tokens d
        LEFT JOIN profile_stats_deleted_threads dt ON dt.thread_id = d.thread_id
        WHERE d.created_at >= ${window.from}
          AND d.created_at < ${window.to}
          AND (COALESCE(d.provider, 'unknown') != 'claudeAgent' OR d.token_accounting_version = 1)
        UNION ALL
        SELECT
          d.created_at, d.dispatch_origin, d.provider, d.model, d.project_id, d.tokens,
          0, NULL, NULL, NULL
        FROM usage_analytics_deleted_tokens d
        WHERE d.created_at >= ${window.from} AND d.created_at < ${window.to}
      )
      SELECT
        ${sql.literal(QUARTER_HOUR("r.created_at"))} AS hour,
        r.origin AS origin,
        r.provider AS provider,
        r.model AS model,
        p.project_id AS projectId,
        p.title AS title,
        SUM(r.tokens) AS tokens,
        SUM(r.cache_tokens) AS cacheTokens,
        SUM(CASE WHEN r.output_tokens IS NOT NULL THEN r.tokens ELSE 0 END) AS splitTokens,
        SUM(CASE WHEN r.output_tokens IS NOT NULL THEN COALESCE(r.split_cache_tokens, 0) ELSE 0 END)
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
          ${sql.literal(QUARTER_HOUR("pt.requested_at"))} AS hour,
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
    // each turn costs its increase over that provider's previous total in the thread
    // (a drop means a new session, which starts from zero).
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
            THEN json_extract(a.payload_json, '$.cumulativeCostUsd') END AS cumulative_cost,
          CASE WHEN json_valid(a.payload_json)
            THEN json_extract(a.payload_json, '$.provider') END AS payload_provider,
          CASE WHEN json_valid(a.payload_json)
            THEN json_extract(a.payload_json, '$.tokenAccountingVersion') END AS accounting_version
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
          -- Each provider keeps its own running total, so a thread that goes
          -- Cursor → Grok → Cursor compares each total with its own last one.
          LAG(cumulative_cost) OVER (
            PARTITION BY thread_id, COALESCE(payload_provider, '')
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
        SELECT thread_id, turn_id, created_at, turn_cost AS cost, payload_provider, accounting_version
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
          END,
          NULL,
          NULL
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
          ${sql.literal(QUARTER_HOUR("c.created_at"))} AS hour,
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
          -- Before per-turn accounting (tokenAccountingVersion 1), Claude stored the
          -- SDK's running process total as each turn's cost; summing those would
          -- count earlier turns again.
          AND NOT (
            COALESCE(c.payload_provider, ${providerColumn}) = 'claudeAgent'
            AND c.accounting_version IS NOT 1
          )
      )
      GROUP BY hour, provider, model, projectId, title
    `;

    const getUsageAnalytics: UsageAnalyticsQueryShape["getUsageAnalytics"] = (input) =>
      Effect.gen(function* () {
        const window = resolveUsageAnalyticsWindow(input);
        const scope = input.scope ?? "synara";
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
            projectRoots: scope === "mac" ? queryProjectRoots() : Effect.succeed([]),
          }),
        );
        const scan =
          scope === "mac"
            ? yield* Effect.promise(() => sessionFiles.scan(Date.parse(window.from)))
            : null;
        // The price list is only needed, and only downloaded, when something
        // without a reported cost has tokens to price.
        const prices =
          needsPrices(rows.tokenRows, reportingProviders(rows.costRows)) ||
          (scan !== null && scanNeedsPrices(scan))
            ? yield* Effect.promise(() => pricing.load())
            : NOT_NEEDED;
        const projectRoots: ProjectRoot[] = [];
        for (const root of rows.projectRoots) {
          const path = nonEmptyString(root.path);
          const title = nonEmptyString(root.title);
          if (!path) continue;
          projectRoots.push({
            path: nodePath.resolve(path),
            project: root.kind === "project" && title ? { projectId: root.projectId, title } : null,
          });
        }
        return buildUsageAnalytics({
          window,
          ...rows,
          prices,
          nowMs: now(),
          scope,
          ...(scan
            ? { sessionFiles: buildTranscriptRows({ scan, window, prices, projectRoots }) }
            : {}),
        });
      });

    return { getUsageAnalytics } satisfies UsageAnalyticsQueryShape;
  });

export const UsageAnalyticsQueryLive = Layer.effect(
  UsageAnalyticsQuery,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return yield* makeUsageAnalyticsQuery({
      pricing: makeUsagePricingSource({ stateDir: config.stateDir }),
      sessionFiles: makeTranscriptUsageReader(defaultTranscriptRoots(config.homeDir)),
    });
  }),
);
