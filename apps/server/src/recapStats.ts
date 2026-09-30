// FILE: recapStats.ts
// Purpose: Time-window recap for the Inbox from Synara's local projection DB:
// prompts, chats, turns, agent run time and token deltas per slot, plus the
// window's top projects and models. Shares the token SQL with profileStats.ts.
// Layer: server stats query service (SqlClient). Beta-only ("inbox").

import {
  type ProviderKind,
  STATS_RECAP_MAX_WINDOW_MS,
  type StatsGetRecapInput,
  type StatsGetRecapResult,
  type StatsRecapModel,
  type StatsRecapProject,
  type StatsRecapSlot,
  type StatsRecapTokens,
  WsRpcError,
} from "@synara/contracts";
import { INBOX_BETA_FEATURE } from "@synara/shared/betaFeatures";
import { normalizeModelSlug, stripClaudeContextWindowSuffix } from "@synara/shared/model";
import { Effect, Layer, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { isServerBetaFeatureEnabled } from "./betaFeatureGate";
import {
  nonEmptyString,
  normalizeProviderKind,
  num,
  tokenDeltaCtes,
  turnModelSelectionCte,
  userPromptEventsQuery,
} from "./profileStats";

const RECAP_TOP_LIMIT = 5;
const HOUR_MS = 3_600_000;
// A turn still running from before the window counts only if it started within
// a day of it, so a legacy row no restart ever closed cannot claim the window.
const RUNNING_TURN_LOOKBACK_MS = 24 * HOUR_MS;
const MODEL_DATE_SUFFIX_PATTERN = /-\d{8}$/u;

/** A half-open `[from, to)` range as canonical ISO instants and epoch ms. */
export interface RecapRange {
  readonly from: string;
  readonly to: string;
  readonly fromMs: number;
  readonly toMs: number;
}

export interface RecapRanges {
  readonly window: RecapRange;
  readonly slots: ReadonlyArray<RecapRange>;
}

/** One prompt the user sent in the window; the project only when it ranks (a real project). */
interface PromptRow {
  readonly threadId: string;
  readonly createdAt: string;
  readonly projectId: string | null;
  readonly projectTitle: string | null;
}

interface TokenBucketRow {
  readonly bucket: number;
  readonly origin: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly projectId: string | null;
  readonly title: string | null;
  readonly tokens: number;
}

interface TurnRow {
  readonly requestedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly state: string | null;
  readonly provider: string | null;
  readonly model: string | null;
}

// ── Pure helpers ───────────────────────────────────────────────────────

function recapRange(fromMs: number, toMs: number): RecapRange {
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    fromMs,
    toMs,
  };
}

/**
 * The window and its slots, as canonical ISO instants so SQL text comparisons
 * match stored timestamps. Returns an error message for a window the recap
 * refuses (reversed, too long, or boundaries outside or unordered).
 */
export function resolveRecapRanges(
  input: StatsGetRecapInput,
): RecapRanges | { readonly error: string } {
  const fromMs = Date.parse(input.from);
  const toMs = Date.parse(input.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    return { error: "The recap window must start before it ends." };
  }
  if (toMs - fromMs > STATS_RECAP_MAX_WINDOW_MS) {
    return {
      error: `The recap window can span at most ${STATS_RECAP_MAX_WINDOW_MS / HOUR_MS} hours.`,
    };
  }
  const edges = [fromMs];
  for (const boundary of input.slotBoundaries) {
    const boundaryMs = Date.parse(boundary);
    const previousMs = edges.at(-1) ?? fromMs;
    if (!Number.isFinite(boundaryMs) || boundaryMs <= previousMs || boundaryMs >= toMs) {
      return { error: "Recap slot boundaries must be ascending and inside the window." };
    }
    edges.push(boundaryMs);
  }
  edges.push(toMs);
  return {
    window: recapRange(fromMs, toMs),
    slots: edges.slice(1).map((edgeMs, index) => recapRange(edges[index] ?? fromMs, edgeMs)),
  };
}

function recapOrigin(value: string | null): keyof StatsRecapTokens {
  return value === "automation" || value === "agent" ? value : "user";
}

/**
 * One model per release: drops the Claude context-window qualifier (`[1m]`) and
 * a provider date stamp, so the selected model a turn records and the dated id
 * its usage reports land on the same row.
 */
export function recapModelName(provider: ProviderKind | "unknown", model: string | null): string {
  const slug = nonEmptyString(model);
  if (!slug) return "unknown";
  const normalized = provider === "unknown" ? slug : (normalizeModelSlug(slug, provider) ?? slug);
  return stripClaudeContextWindowSuffix(normalized).replace(MODEL_DATE_SUFFIX_PATTERN, "");
}

/**
 * When a turn ran, in epoch ms. A turn without a completion time runs up to now
 * only while its state says it is running; anything else never ran or never
 * reported an end.
 */
export function turnRunSpan(
  turn: Pick<TurnRow, "startedAt" | "completedAt" | "state">,
  nowMs: number,
): { readonly startMs: number; readonly endMs: number } | null {
  const startMs = Date.parse(turn.startedAt ?? "");
  if (!Number.isFinite(startMs)) return null;
  const completedMs = Date.parse(turn.completedAt ?? "");
  if (Number.isFinite(completedMs)) return { startMs, endMs: completedMs };
  return turn.state === "running" ? { startMs, endMs: nowMs } : null;
}

function overlapMs(
  span: { readonly startMs: number; readonly endMs: number },
  range: RecapRange,
): number {
  const ms = Math.min(span.endMs, range.toMs) - Math.max(span.startMs, range.fromMs);
  return ms > 0 ? Math.round(ms) : 0;
}

function isWithin(ms: number, range: RecapRange): boolean {
  return ms >= range.fromMs && ms < range.toMs;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableRecapSlot = Mutable<Omit<StatsRecapSlot, "tokens">> & {
  tokens: Mutable<StatsRecapTokens>;
};

function emptySlot(range: RecapRange): MutableRecapSlot {
  return {
    from: range.from,
    to: range.to,
    prompts: 0,
    chats: 0,
    turns: 0,
    failedTurns: 0,
    agentWorkMs: 0,
    tokens: { user: 0, automation: 0, agent: 0 },
  };
}

/** SQL bucket 0 is the whole window; bucket `i` is slot `i - 1`. */
function sqlBuckets(ranges: RecapRanges): ReadonlyArray<RecapRange> {
  return [ranges.window, ...ranges.slots];
}

export function buildRecap(input: {
  readonly ranges: RecapRanges;
  readonly promptRows: ReadonlyArray<PromptRow>;
  readonly tokenRows: ReadonlyArray<TokenBucketRow>;
  readonly turnRows: ReadonlyArray<TurnRow>;
  readonly nowMs: number;
}): StatsGetRecapResult {
  const { ranges } = input;
  // Same order as sqlBuckets, so a row's bucket number indexes this list.
  const buckets = sqlBuckets(ranges).map((range) => ({ range, slot: emptySlot(range) }));
  const [totals = emptySlot(ranges.window), ...slots] = buckets.map((bucket) => bucket.slot);
  const slotForBucket = (bucket: unknown) => buckets[num(bucket)]?.slot;

  const projects = new Map<string, Mutable<StatsRecapProject>>();
  const projectFor = (projectId: string | null, title: string | null) => {
    const id = nonEmptyString(projectId);
    const name = nonEmptyString(title);
    if (!id || !name) return null;
    const existing = projects.get(id);
    if (existing) return existing;
    const created = { projectId: id, title: name, prompts: 0, chats: 0, tokens: 0 };
    projects.set(id, created);
    return created;
  };
  // Prompts are few per day, so they are bucketed here with the same rule as turns.
  const chatsByBucket = buckets.map(() => new Set<string>());
  const chatsByProject = new Map<string, Set<string>>();
  for (const row of input.promptRows) {
    const createdMs = Date.parse(row.createdAt);
    buckets.forEach(({ range, slot }, index) => {
      if (!isWithin(createdMs, range)) return;
      slot.prompts += 1;
      chatsByBucket[index]?.add(row.threadId);
    });
    const project = isWithin(createdMs, ranges.window)
      ? projectFor(row.projectId, row.projectTitle)
      : null;
    if (!project) continue;
    project.prompts += 1;
    const chats = chatsByProject.get(project.projectId) ?? new Set<string>();
    chats.add(row.threadId);
    chatsByProject.set(project.projectId, chats);
  }
  buckets.forEach(({ slot }, index) => {
    slot.chats = chatsByBucket[index]?.size ?? 0;
  });
  for (const project of projects.values()) {
    project.chats = chatsByProject.get(project.projectId)?.size ?? 0;
  }

  const models = new Map<string, Mutable<StatsRecapModel>>();
  const modelFor = (provider: string | null, model: string | null) => {
    const normalizedProvider = normalizeProviderKind(provider);
    const normalizedModel = recapModelName(normalizedProvider, model);
    const key = `${normalizedProvider}\u0000${normalizedModel}`;
    const existing = models.get(key);
    if (existing) return existing;
    const created = { provider: normalizedProvider, model: normalizedModel, turns: 0, tokens: 0 };
    models.set(key, created);
    return created;
  };

  const providersWithTokens = new Set<ProviderKind>();
  for (const row of input.tokenRows) {
    const slot = slotForBucket(row.bucket);
    const tokens = Math.round(num(row.tokens));
    if (!slot || tokens <= 0) continue;
    slot.tokens[recapOrigin(row.origin)] += tokens;
    if (slot !== totals) continue;
    const provider = normalizeProviderKind(row.provider);
    if (provider !== "unknown") providersWithTokens.add(provider);
    modelFor(row.provider, row.model).tokens += tokens;
    const project = projectFor(row.projectId, row.title);
    if (project) project.tokens += tokens;
  }

  const providersWithCompletedTurns = new Set<ProviderKind>();
  for (const turn of input.turnRows) {
    const span = turnRunSpan(turn, input.nowMs);
    const requestedMs = Date.parse(turn.requestedAt ?? "");
    for (const { range, slot } of buckets) {
      if (span) slot.agentWorkMs += overlapMs(span, range);
      if (isWithin(requestedMs, range)) {
        slot.turns += 1;
        if (turn.state === "error") slot.failedTurns += 1;
      }
    }
    if (!isWithin(requestedMs, ranges.window)) continue;
    modelFor(turn.provider, turn.model).turns += 1;
    const provider = normalizeProviderKind(turn.provider);
    // Only a completed turn proves that a provider reports no usage: a running
    // turn has none yet, and one that failed early may never have emitted any.
    if (provider !== "unknown" && turn.state === "completed") {
      providersWithCompletedTurns.add(provider);
    }
  }

  return {
    generatedAt: new Date(input.nowMs).toISOString(),
    totals,
    slots,
    projects: [...projects.values()]
      .filter((project) => project.prompts > 0 || project.tokens > 0)
      .toSorted(
        (left, right) =>
          right.prompts - left.prompts ||
          right.tokens - left.tokens ||
          left.title.localeCompare(right.title),
      )
      .slice(0, RECAP_TOP_LIMIT),
    models: [...models.values()]
      .filter((model) => model.turns > 0 || model.tokens > 0)
      .toSorted(
        (left, right) =>
          right.tokens - left.tokens ||
          right.turns - left.turns ||
          left.model.localeCompare(right.model),
      )
      .slice(0, RECAP_TOP_LIMIT),
    unavailableProviders: [...providersWithCompletedTurns]
      .filter((provider) => !providersWithTokens.has(provider))
      .toSorted(),
  };
}

// ── Service ────────────────────────────────────────────────────────────

export interface RecapStatsQueryShape {
  readonly getRecap: (input: StatsGetRecapInput) => Effect.Effect<StatsGetRecapResult, unknown>;
}

export class RecapStatsQuery extends ServiceMap.Service<RecapStatsQuery, RecapStatsQueryShape>()(
  "synara/recapStats/RecapStatsQuery",
) {}

export const makeRecapStatsQuery = (
  options: {
    readonly isInboxEnabled?: () => boolean;
    readonly now?: () => number;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const isInboxEnabled =
      options.isInboxEnabled ?? (() => isServerBetaFeatureEnabled(INBOX_BETA_FEATURE));
    const now = options.now ?? Date.now;

    const bucketsCte = (ranges: RecapRanges) =>
      sql.join(
        " UNION ALL ",
        false,
      )(
        sqlBuckets(ranges).map(
          (range, index) =>
            sql`SELECT ${index} AS bucket, ${range.from} AS bucket_from, ${range.to} AS bucket_to`,
        ),
      );

    // Only real projects rank: per-chat and Studio containers, and deleted projects, don't.
    const queryPrompts = (ranges: RecapRanges) =>
      sql<PromptRow>`
        WITH prompt_events AS (${userPromptEventsQuery(sql, ranges.window)})
        SELECT
          e.thread_id AS threadId,
          e.created_at AS createdAt,
          p.project_id AS projectId,
          p.title AS projectTitle
        FROM prompt_events e
        LEFT JOIN projection_projects p
          ON p.project_id = e.project_id
         AND p.kind = 'project'
         AND p.deleted_at IS NULL
      `;

    // Deltas need each thread's full history (see tokenDeltaCtes), so the scope
    // is every thread with token activity in the window and the time filter
    // applies to the computed delta rows. A purged thread keeps its user prompts and
    // user tokens here (the Profile archive stores those with their times) but its
    // turns, agent time, and automation or agent tokens leave the recap: the archive
    // keeps only untimed turn totals and user-dispatched tokens.
    const queryTokens = (ranges: RecapRanges) => {
      const { window } = ranges;
      return sql<TokenBucketRow>`
        WITH recap_threads AS (
          SELECT DISTINCT thread_id
          FROM projection_thread_activities
          WHERE kind IN ('context-window.updated', 'turn.completed')
            AND created_at >= ${window.from}
            AND created_at < ${window.to}
        ),
        ${tokenDeltaCtes(sql, { threadIdsQuery: sql`SELECT thread_id FROM recap_threads` })},
        recap_buckets AS (${bucketsCte(ranges)}),
        recap_token_rows AS (
          SELECT
            r.created_at AS created_at,
            r.dispatch_origin AS origin,
            r.provider AS provider,
            r.model AS model,
            t.project_id AS project_id,
            r.tokens AS tokens
          FROM token_delta_rows r
          JOIN projection_threads t ON t.thread_id = r.thread_id
          WHERE r.created_at >= ${window.from} AND r.created_at < ${window.to}
          UNION ALL
          SELECT
            d.created_at,
            'user',
            COALESCE(d.provider, 'unknown'),
            COALESCE(d.model, 'unknown'),
            dt.project_id,
            d.tokens
          FROM profile_stats_deleted_tokens d
          LEFT JOIN profile_stats_deleted_threads dt ON dt.thread_id = d.thread_id
          WHERE d.created_at >= ${window.from}
            AND d.created_at < ${window.to}
            AND (COALESCE(d.provider, 'unknown') != 'claudeAgent' OR d.token_accounting_version = 1)
        )
        SELECT
          b.bucket AS bucket,
          r.origin AS origin,
          r.provider AS provider,
          r.model AS model,
          p.project_id AS projectId,
          p.title AS title,
          SUM(r.tokens) AS tokens
        FROM recap_buckets b
        JOIN recap_token_rows r ON r.created_at >= b.bucket_from AND r.created_at < b.bucket_to
        LEFT JOIN projection_projects p
          ON p.project_id = r.project_id
         AND p.kind = 'project'
         AND p.deleted_at IS NULL
        GROUP BY b.bucket, r.origin, r.provider, r.model, p.project_id, p.title
      `;
    };

    // Turns requested in the window, earlier turns that ran into it, and turns
    // still running since shortly before it. Subagent (provider-native child)
    // threads are left out: their parent turn already covers that work.
    const queryTurns = (ranges: RecapRanges) => {
      const { window } = ranges;
      const runningSince = new Date(window.fromMs - RUNNING_TURN_LOOKBACK_MS).toISOString();
      const overlapsWindow = (turns: string) => {
        const alias = sql.literal(turns);
        return sql`
          ${alias}.turn_id IS NOT NULL
          AND ${alias}.requested_at < ${window.to}
          AND (
            ${alias}.requested_at >= ${window.from}
            OR ${alias}.completed_at >= ${window.from}
            OR (
              ${alias}.completed_at IS NULL
              AND ${alias}.state = 'running'
              AND ${alias}.started_at >= ${runningSince}
            )
          )
        `;
      };
      return sql<TurnRow>`
        WITH turn_model AS (
          ${turnModelSelectionCte(sql, {
            threadIdsQuery: sql`
              SELECT scoped.thread_id FROM projection_turns scoped WHERE ${overlapsWindow("scoped")}
            `,
          })}
        )
        SELECT
          pt.requested_at AS requestedAt,
          pt.started_at AS startedAt,
          pt.completed_at AS completedAt,
          pt.state AS state,
          COALESCE(
            tm.provider,
            CASE
              WHEN tm.instanceId = s.provider_instance_id THEN s.provider_name
              ELSE tm.instanceId
            END,
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
          ) AS provider,
          COALESCE(
            tm.model,
            CASE WHEN json_valid(th.model_selection_json)
              THEN json_extract(th.model_selection_json, '$.model') END
          ) AS model
        FROM projection_turns pt
        JOIN projection_threads th ON th.thread_id = pt.thread_id
        LEFT JOIN turn_model tm ON tm.thread_id = pt.thread_id AND tm.turn_id = pt.turn_id
        LEFT JOIN projection_thread_sessions s ON s.thread_id = pt.thread_id
        WHERE ${overlapsWindow("pt")}
          AND COALESCE(th.creation_source, '') != 'provider_native'
      `;
    };

    const getRecap: RecapStatsQueryShape["getRecap"] = (input) =>
      Effect.gen(function* () {
        if (!isInboxEnabled()) {
          return yield* Effect.fail(
            new WsRpcError({
              message: "The Inbox is available in Synara Beta.",
              code: "FEATURE_UNAVAILABLE",
              retryable: false,
            }),
          );
        }
        const ranges = resolveRecapRanges(input);
        if ("error" in ranges) {
          return yield* Effect.fail(
            new WsRpcError({ message: ranges.error, code: "INVALID_INPUT", retryable: false }),
          );
        }
        // One transaction so every part of the recap reads the same snapshot.
        const rows = yield* sql.withTransaction(
          Effect.all({
            promptRows: queryPrompts(ranges),
            tokenRows: queryTokens(ranges),
            turnRows: queryTurns(ranges),
          }),
        );
        return buildRecap({ ranges, ...rows, nowMs: now() });
      });

    return { getRecap } satisfies RecapStatsQueryShape;
  });

export const RecapStatsQueryLive = Layer.effect(RecapStatsQuery, makeRecapStatsQuery());
