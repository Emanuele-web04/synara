// FILE: usageAnalyticsStats.test.ts
// Purpose: Usage analytics SQL against the migrated SQLite schema: hourly token
// deltas, turns, and provider-reported cost (per turn and running totals).
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

const NOW = Date.parse("2026-09-30T19:00:00.000Z");
const WINDOW = { from: "2026-09-30T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };

function runTest<A, E>(effect: Effect.Effect<A, E, UsageAnalyticsQuery | SqlClient.SqlClient>) {
  const layer = Layer.effect(UsageAnalyticsQuery, makeUsageAnalyticsQuery({ now: () => NOW })).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  );
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

    expect(result.projects).toEqual([{ projectId: "project-app", title: "App" }]);
    expect(result.unavailableProviders).toEqual(["cursor"]);
  });
});
