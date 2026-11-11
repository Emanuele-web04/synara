// FILE: usageAnalyticsStats.test.ts
// Purpose: Usage analytics SQL against the migrated SQLite schema: hourly token
// deltas, turns, provider-reported cost (per turn and running totals), and the
// API-price estimate for a provider that reports none.
// Layer: Server stats tests

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import {
  makeUsageAnalyticsQuery,
  resolveUsageAnalyticsWindow,
  UsageAnalyticsQuery,
} from "./usageAnalyticsStats";
import type { TranscriptUsageReader } from "./transcriptUsage";
import type { TranscriptRecord } from "./transcriptUsageParsers";
import type { UsagePricingSource } from "./usagePricing";

const NOW = Date.parse("2026-09-30T19:00:00.000Z");
const WINDOW = { from: "2026-09-30T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };

// USD per token, as in LiteLLM's table.
const PRICING: UsagePricingSource = {
  load: async () => ({
    status: "fresh",
    fetchedAt: "2026-09-30T00:00:00.000Z",
    table: new Map([
      [
        "gpt-5-codex",
        {
          input: 1e-6,
          output: 1e-5,
          cacheRead: 1e-7,
          cacheWrite: 1e-6,
          cacheWrite1h: 1e-6,
          tiers: [],
          fastMultiplier: 1,
        },
      ],
    ]),
  }),
};

const usage = (
  overrides: Partial<Extract<TranscriptRecord, { kind: "usage" }>>,
): TranscriptRecord => ({
  kind: "usage",
  provider: "claudeAgent",
  timestampMs: Date.parse("2026-09-30T10:00:05.000Z"),
  model: "claude-sonnet-5-5",
  cwd: "/work/app/sub",
  tokens: {
    inputTokens: 1_000,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 100,
  },
  reportedCostUsd: null,
  fast: false,
  failed: false,
  dedupeKey: null,
  ...overrides,
});

// Two Claude files (the second resumed the first and copied its response) and
// one Codex session in a folder Synara does not know.
const SESSION_FILES: TranscriptUsageReader = {
  scan: async () => ({
    providers: new Set(["claudeAgent", "codex"] as const),
    files: [
      [
        {
          kind: "turn",
          provider: "claudeAgent",
          timestampMs: Date.parse("2026-09-30T10:00:00.000Z"),
          model: "",
          cwd: "/work/app/sub",
          dedupeKey: "prompt:u1",
        },
        usage({ dedupeKey: "m1:r1", reportedCostUsd: 0.3 }),
      ],
      [usage({ dedupeKey: "m1:r1", reportedCostUsd: 0.3 })],
      [usage({ provider: "codex", model: "gpt-5-codex", cwd: "/elsewhere/tool" })],
      // A Claude Code worktree of an unknown repo counts as that repo.
      [
        usage({
          dedupeKey: "m2:r2",
          reportedCostUsd: 0.1,
          cwd: "/elsewhere/tool/.claude/worktrees/feature-x",
        }),
      ],
    ],
  }),
};

function runTest<A, E>(effect: Effect.Effect<A, E, UsageAnalyticsQuery | SqlClient.SqlClient>) {
  const layer = Layer.effect(
    UsageAnalyticsQuery,
    makeUsageAnalyticsQuery({ now: () => NOW, pricing: PRICING, sessionFiles: SESSION_FILES }),
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provide(NodeServices.layer));
  return effect.pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
}

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, kind, created_at, updated_at, deleted_at
    )
    VALUES
      ('project-app', 'App', '/work/app', '{}', 'project',
        '2026-09-01T09:00:00.000Z', '2026-09-01T09:00:00.000Z', NULL),
      ('project-chat', 'Busy chat', '/chats/busy', '{}', 'chat',
        '2026-09-01T09:00:00.000Z', '2026-09-01T09:00:00.000Z', NULL)
  `;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, env_mode, created_at, updated_at, deleted_at
    )
    VALUES
      ('thread-codex', 'project-app', 'App work', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', 'local',
        '2026-09-29T19:00:00.000Z', '2026-09-30T18:30:00.000Z', NULL),
      ('thread-cursor', 'project-chat', 'Chat', '{"provider":"cursor","model":"auto"}',
        'full-access', 'default', 'local',
        '2026-09-30T08:00:00.000Z', '2026-09-30T09:30:00.000Z', NULL)
  `;
  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, is_streaming, source, dispatch_origin,
      created_at, updated_at
    )
    VALUES
      ('m-c0', 'thread-codex', 'turn-c0', 'user', 'yesterday', 0, 'native', 'user',
        '2026-09-29T20:00:00.000Z', '2026-09-29T20:00:00.000Z'),
      ('m-c1', 'thread-codex', 'turn-c1', 'user', 'morning', 0, 'native', 'user',
        '2026-09-30T05:00:00.000Z', '2026-09-30T05:00:00.000Z'),
      ('m-c2', 'thread-codex', 'turn-c2', 'user', 'afternoon', 0, 'native', 'user',
        '2026-09-30T13:00:00.000Z', '2026-09-30T13:00:00.000Z'),
      ('m-u1', 'thread-cursor', 'turn-u1', 'user', 'one', 0, 'native', 'user',
        '2026-09-30T09:00:00.000Z', '2026-09-30T09:00:00.000Z'),
      ('m-u2', 'thread-cursor', 'turn-u2', 'user', 'two', 0, 'native', 'user',
        '2026-09-30T09:10:00.000Z', '2026-09-30T09:10:00.000Z')
  `;
  yield* sql`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type,
      occurred_at, actor_kind, payload_json, metadata_json
    )
    VALUES
      ('e-c0', 'thread', 'thread-codex', 1, 'thread.turn-start-requested', '2026-09-29T20:00:00.000Z',
        'client', '{"threadId":"thread-codex","messageId":"m-c0","modelSelection":{"provider":"codex","model":"gpt-5-codex"}}', '{}'),
      ('e-c1', 'thread', 'thread-codex', 2, 'thread.turn-start-requested', '2026-09-30T05:00:00.000Z',
        'client', '{"threadId":"thread-codex","messageId":"m-c1","modelSelection":{"provider":"codex","model":"gpt-5-codex"}}', '{}'),
      ('e-c2', 'thread', 'thread-codex', 3, 'thread.turn-start-requested', '2026-09-30T13:00:00.000Z',
        'client', '{"threadId":"thread-codex","messageId":"m-c2","modelSelection":{"provider":"codex","model":"gpt-5-codex"}}', '{}'),
      ('e-u1', 'thread', 'thread-cursor', 1, 'thread.turn-start-requested', '2026-09-30T09:00:00.000Z',
        'client', '{"threadId":"thread-cursor","messageId":"m-u1","modelSelection":{"provider":"cursor","model":"auto"}}', '{}'),
      ('e-u2', 'thread', 'thread-cursor', 2, 'thread.turn-start-requested', '2026-09-30T09:10:00.000Z',
        'client', '{"threadId":"thread-cursor","messageId":"m-u2","modelSelection":{"provider":"cursor","model":"auto"}}', '{}')
  `;
  yield* sql`
    INSERT INTO projection_turns (
      thread_id, turn_id, pending_message_id, state, requested_at, started_at, completed_at,
      checkpoint_files_json
    )
    VALUES
      ('thread-codex', 'turn-c0', 'm-c0', 'completed', '2026-09-29T20:00:00.000Z',
        '2026-09-29T20:00:00.000Z', '2026-09-29T20:10:00.000Z', '[]'),
      ('thread-codex', 'turn-c1', 'm-c1', 'completed', '2026-09-30T05:00:00.000Z',
        '2026-09-30T05:00:00.000Z', '2026-09-30T05:10:00.000Z', '[]'),
      ('thread-codex', 'turn-c2', 'm-c2', 'error', '2026-09-30T13:00:00.000Z',
        '2026-09-30T13:00:00.000Z', '2026-09-30T13:30:00.000Z', '[]'),
      ('thread-cursor', 'turn-u1', 'm-u1', 'completed', '2026-09-30T09:00:00.000Z',
        '2026-09-30T09:00:00.000Z', '2026-09-30T09:05:00.000Z', '[]'),
      ('thread-cursor', 'turn-u2', 'm-u2', 'completed', '2026-09-30T09:10:00.000Z',
        '2026-09-30T09:10:00.000Z', '2026-09-30T09:15:00.000Z', '[]')
  `;
  // Codex's counter reached 50k yesterday, so today's first delta is 30k. Codex
  // reports per-turn cost; Cursor reports a running total and no tokens.
  yield* sql`
    INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
    )
    VALUES
      ('x-c0', 'thread-codex', 'turn-c0', 'info', 'context-window.updated', 'tokens',
        '{"provider":"codex","totalProcessedTokens":50000}', 1, '2026-09-29T20:05:00.000Z'),
      ('x-c1', 'thread-codex', 'turn-c1', 'info', 'context-window.updated', 'tokens',
        '{"provider":"codex","totalProcessedTokens":80000}', 2, '2026-09-30T05:05:00.000Z'),
      ('d-c1', 'thread-codex', 'turn-c1', 'info', 'turn.completed', 'done',
        '{"state":"completed","totalCostUsd":0.25}', 3, '2026-09-30T05:10:00.000Z'),
      ('x-c2', 'thread-codex', 'turn-c2', 'info', 'context-window.updated', 'tokens',
        '{"provider":"codex","totalProcessedTokens":90000}', 4, '2026-09-30T13:10:00.000Z'),
      ('d-u1', 'thread-cursor', 'turn-u1', 'info', 'turn.completed', 'done',
        '{"state":"completed","cumulativeCostUsd":1.5}', 1, '2026-09-30T09:05:00.000Z'),
      ('d-u2', 'thread-cursor', 'turn-u2', 'info', 'turn.completed', 'done',
        '{"state":"completed","cumulativeCostUsd":2}', 2, '2026-09-30T09:15:00.000Z')
  `;
});

describe("resolveUsageAnalyticsWindow", () => {
  it("accepts a year and refuses longer or reversed windows", () => {
    const from = Date.parse(WINDOW.from);
    const day = 86_400_000;
    expect(
      resolveUsageAnalyticsWindow({
        from: WINDOW.from,
        to: new Date(from + 366 * day).toISOString(),
      }),
    ).not.toHaveProperty("error");
    expect(
      resolveUsageAnalyticsWindow({
        from: WINDOW.from,
        to: new Date(from + 400 * day).toISOString(),
      }),
    ).toHaveProperty("error");
    expect(resolveUsageAnalyticsWindow({ from: WINDOW.to, to: WINDOW.from })).toHaveProperty(
      "error",
    );
  });
});

describe("UsageAnalyticsQuery", () => {
  it("returns hourly token deltas, turns and reported cost for the window", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* seed;
        const query = yield* UsageAnalyticsQuery;
        return yield* query.getUsageAnalytics(WINDOW);
      }),
    );

    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hour: "2026-09-30T05:00:00.000Z",
          provider: "codex",
          projectId: "project-app",
          origin: "user",
          tokens: 30_000,
        }),
        expect.objectContaining({ hour: "2026-09-30T13:00:00.000Z", tokens: 10_000 }),
      ]),
    );
    expect(result.tokens.reduce((sum, row) => sum + row.tokens, 0)).toBe(40_000);

    expect(result.turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hour: "2026-09-30T13:00:00.000Z", turns: 1, failedTurns: 1 }),
        // A chat container is not a project.
        expect.objectContaining({ provider: "cursor", projectId: null, turns: 2 }),
      ]),
    );

    const costByProvider = Object.fromEntries(
      result.costs.map((row) => [row.provider, row.costUsd]),
    );
    expect(costByProvider.codex).toBeCloseTo(0.25);
    // A running total of 1.5 then 2 is two turns costing 1.5 and 0.5.
    expect(costByProvider.cursor).toBeCloseTo(2);
    // Codex reported its own cost here, so its tokens are not priced again.
    expect(result.costs.every((row) => row.source === "reported")).toBe(true);
    // Nothing needed an estimate, so the price list was not loaded.
    expect(result.pricing).toEqual({ status: "unavailable", fetchedAt: null });

    expect(result.projects).toEqual([{ projectId: "project-app", title: "App" }]);
    expect(result.unavailableProviders).toEqual(["cursor"]);
  });
});

describe("UsageAnalyticsQuery estimates", () => {
  // Codex reports no cost. Its session totals split each step into cached
  // input, output and the rest, which are priced at the model's API rates.
  const seedCodexWithoutCost = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, env_mode, created_at, updated_at, deleted_at
      )
      VALUES
        ('thread-priced', 'project-none', 'Priced', '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access', 'default', 'local',
          '2026-09-30T08:00:00.000Z', '2026-09-30T09:00:00.000Z', NULL),
        ('thread-unpriced', 'project-none', 'Unpriced', '{"provider":"codex","model":"gpt-9-mystery"}',
          'full-access', 'default', 'local',
          '2026-09-30T08:00:00.000Z', '2026-09-30T09:00:00.000Z', NULL)
    `;
    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
      )
      VALUES
        ('p-1', 'thread-priced', NULL, 'info', 'context-window.updated', 'tokens',
          '{"provider":"codex","usedTokens":1000,"totalProcessedTokens":1000,"cumulativeUsage":{"inputTokens":900,"outputTokens":100,"cachedInputTokens":600}}',
          1, '2026-09-30T08:10:00.000Z'),
        ('p-2', 'thread-priced', NULL, 'info', 'context-window.updated', 'tokens',
          '{"provider":"codex","usedTokens":2000,"totalProcessedTokens":3000,"cumulativeUsage":{"inputTokens":2700,"outputTokens":300,"cachedInputTokens":2000}}',
          2, '2026-09-30T08:20:00.000Z'),
        ('u-1', 'thread-unpriced', NULL, 'info', 'context-window.updated', 'tokens',
          '{"provider":"codex","usedTokens":500,"totalProcessedTokens":500,"cumulativeUsage":{"inputTokens":450,"outputTokens":50}}',
          1, '2026-09-30T08:30:00.000Z')
    `;
  });

  it("prices tokens of a provider that reports no cost", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* seedCodexWithoutCost;
        const query = yield* UsageAnalyticsQuery;
        return yield* query.getUsageAnalytics(WINDOW);
      }),
    );

    // 3,000 tokens: 2,000 cached, 300 output, 700 other input.
    const estimated = result.costs.filter((row) => row.source === "estimated");
    expect(estimated).toHaveLength(1);
    expect(estimated[0]).toMatchObject({ provider: "codex", model: "gpt-5-codex", turns: 0 });
    expect(estimated[0]?.costUsd).toBeCloseTo(700e-6 + 2000e-7 + 300e-5, 10);

    expect(result.pricing).toEqual({ status: "fresh", fetchedAt: "2026-09-30T00:00:00.000Z" });
    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "gpt-9-mystery", unpricedTokens: 500, unsplitTokens: 0 }),
        expect.objectContaining({ model: "gpt-5-codex", unpricedTokens: 0, unsplitTokens: 0 }),
      ]),
    );
  });

  it("leaves out Claude costs stored before per-turn accounting", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, env_mode, created_at, updated_at, deleted_at
          )
          VALUES ('thread-claude', 'project-none', 'Claude',
            '{"provider":"claudeAgent","model":"claude-opus-5-5"}', 'full-access', 'default',
            'local', '2026-09-30T08:00:00.000Z', '2026-09-30T09:00:00.000Z', NULL)
        `;
        // The legacy result holds the process's running total (1 + 2 = 3).
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          )
          VALUES
            ('c-legacy', 'thread-claude', 'turn-a', 'info', 'turn.completed', 'done',
              '{"provider":"claudeAgent","state":"completed","totalCostUsd":3}', 1,
              '2026-09-30T08:10:00.000Z'),
            ('c-v1', 'thread-claude', 'turn-b', 'info', 'turn.completed', 'done',
              '{"provider":"claudeAgent","state":"completed","tokenAccountingVersion":1,"totalCostUsd":0.5}',
              2, '2026-09-30T08:20:00.000Z')
        `;
        const query = yield* UsageAnalyticsQuery;
        return yield* query.getUsageAnalytics(WINDOW);
      }),
    );
    expect(result.costs).toEqual([
      expect.objectContaining({ provider: "claudeAgent", source: "reported", costUsd: 0.5 }),
    ]);
  });
});

describe("UsageAnalyticsQuery on this Mac", () => {
  it("reads Claude and Codex from their session files instead of Synara's rows", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* seed;
        const query = yield* UsageAnalyticsQuery;
        return yield* query.getUsageAnalytics({ ...WINDOW, scope: "mac" });
      }),
    );

    expect(result.scope).toBe("mac");
    expect(result.sessionFileProviders).toEqual(["claudeAgent", "codex"]);
    // Synara's own Codex rows are replaced by the session files; Cursor stays.
    expect(result.tokens.every((row) => row.origin === null)).toBe(true);
    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "claudeAgent",
          projectId: "project-app",
          tokens: 1_100,
        }),
        expect.objectContaining({
          provider: "codex",
          projectId: "folder:tool",
          tokens: 1_100,
        }),
      ]),
    );
    expect(result.turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "claudeAgent", model: "claude-sonnet-5-5", turns: 1 }),
      ]),
    );
    const costs: Record<string, number> = {};
    for (const row of result.costs) {
      const key = `${row.provider}:${row.source}`;
      costs[key] = (costs[key] ?? 0) + row.costUsd;
    }
    // The copied response counts once.
    expect(costs["claudeAgent:reported"]).toBeCloseTo(0.4);
    expect(costs["codex:estimated"]).toBeCloseTo(1_000 * 1e-6 + 100 * 1e-5, 10);
    expect(costs["cursor:reported"]).toBeCloseTo(2);
    expect(costs["codex:reported"]).toBeUndefined();
    expect(result.projects).toEqual(
      expect.arrayContaining([{ projectId: "folder:tool", title: "tool" }]),
    );
    expect(result.tokens.filter((row) => row.projectId === "folder:tool")).toHaveLength(2);
  });
});
