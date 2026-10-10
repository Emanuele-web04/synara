// FILE: recapStats.test.ts
// Purpose: Focused coverage for the Inbox recap SQL against the migrated SQLite schema.
// Layer: Server stats tests

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import {
  makeRecapStatsQuery,
  RecapStatsQuery,
  recapModelName,
  resolveRecapRanges,
} from "./recapStats";

const NOW = Date.parse("2026-09-30T19:00:00.000Z");
const RECAP_INPUT = {
  from: "2026-09-30T04:00:00.000Z",
  to: "2026-10-01T04:00:00.000Z",
  slotBoundaries: ["2026-09-30T12:00:00.000Z", "2026-09-30T18:00:00.000Z"],
};

function runRecapTest<A, E>(
  effect: Effect.Effect<A, E, RecapStatsQuery | SqlClient.SqlClient>,
  options: { readonly isInboxEnabled?: () => boolean } = {},
) {
  const layer = Layer.effect(
    RecapStatsQuery,
    makeRecapStatsQuery({ ...options, now: () => NOW }),
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provide(NodeServices.layer));
  return effect.pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
}

const seedDay = Effect.gen(function* () {
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
      ('thread-a', 'project-app', 'App work', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', 'local',
        '2026-09-29T19:00:00.000Z', '2026-09-30T18:30:00.000Z', NULL),
      ('thread-chat', 'project-chat', 'Chat', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', 'local',
        '2026-09-30T08:00:00.000Z', '2026-09-30T09:30:00.000Z', NULL),
      ('thread-auto', 'project-app', 'Nightly check', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', 'local',
        '2026-09-30T14:00:00.000Z', '2026-09-30T14:05:00.000Z', NULL)
  `;
  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, is_streaming, source, dispatch_origin,
      created_at, updated_at
    )
    VALUES
      ('m-a0', 'thread-a', 'turn-a0', 'user', 'yesterday', 0, 'native', 'user',
        '2026-09-29T20:00:00.000Z', '2026-09-29T20:00:00.000Z'),
      ('m-a1', 'thread-a', 'turn-a1', 'user', 'morning', 0, 'native', 'user',
        '2026-09-30T05:00:00.000Z', '2026-09-30T05:00:00.000Z'),
      ('m-a2', 'thread-a', 'turn-a2', 'user', 'afternoon', 0, 'native', 'user',
        '2026-09-30T13:00:00.000Z', '2026-09-30T13:00:00.000Z'),
      ('m-a3', 'thread-a', 'turn-a3', 'user', 'evening', 0, 'native', 'user',
        '2026-09-30T18:30:00.000Z', '2026-09-30T18:30:00.000Z'),
      ('m-c1', 'thread-chat', 'turn-c1', 'user', 'one', 0, 'native', NULL,
        '2026-09-30T09:00:00.000Z', '2026-09-30T09:00:00.000Z'),
      ('m-c2', 'thread-chat', 'turn-c2', 'user', 'two', 0, 'native', NULL,
        '2026-09-30T09:10:00.000Z', '2026-09-30T09:10:00.000Z'),
      ('m-auto', 'thread-auto', 'turn-auto', 'user', 'run check', 0, 'native', 'automation',
        '2026-09-30T14:00:00.000Z', '2026-09-30T14:00:00.000Z')
  `;
  yield* sql`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type,
      occurred_at, actor_kind, payload_json, metadata_json
    )
    VALUES
      ('e-a0', 'thread', 'thread-a', 1, 'thread.turn-start-requested', '2026-09-29T20:00:00.000Z',
        'client', '{"threadId":"thread-a","messageId":"m-a0","modelSelection":{"provider":"codex","model":"gpt-5-codex"}}', '{}'),
      ('e-a1', 'thread', 'thread-a', 2, 'thread.turn-start-requested', '2026-09-30T05:00:00.000Z',
        'client', '{"threadId":"thread-a","messageId":"m-a1","modelSelection":{"provider":"codex","model":"gpt-5-codex"}}', '{}'),
      ('e-a2', 'thread', 'thread-a', 3, 'thread.turn-start-requested', '2026-09-30T13:00:00.000Z',
        'client', '{"threadId":"thread-a","messageId":"m-a2","modelSelection":{"provider":"codex","model":"gpt-5-codex"}}', '{}'),
      ('e-a3', 'thread', 'thread-a', 4, 'thread.turn-start-requested', '2026-09-30T18:30:00.000Z',
        'client', '{"threadId":"thread-a","messageId":"m-a3","modelSelection":{"provider":"codex","model":"gpt-5-codex"}}', '{}'),
      ('e-auto', 'thread', 'thread-auto', 1, 'thread.turn-start-requested', '2026-09-30T14:00:00.000Z',
        'client', '{"threadId":"thread-auto","messageId":"m-auto","modelSelection":{"provider":"codex","model":"gpt-5-codex"}}', '{}')
  `;
  yield* sql`
    INSERT INTO projection_turns (
      thread_id, turn_id, pending_message_id, state, requested_at, started_at, completed_at,
      checkpoint_files_json
    )
    VALUES
      ('thread-a', 'turn-a0', 'm-a0', 'completed', '2026-09-29T20:00:00.000Z',
        '2026-09-29T20:00:00.000Z', '2026-09-29T20:10:00.000Z', '[]'),
      ('thread-a', 'turn-a1', 'm-a1', 'completed', '2026-09-30T05:00:00.000Z',
        '2026-09-30T05:00:00.000Z', '2026-09-30T05:10:00.000Z', '[]'),
      ('thread-a', 'turn-a2', 'm-a2', 'error', '2026-09-30T13:00:00.000Z',
        '2026-09-30T13:00:00.000Z', '2026-09-30T13:30:00.000Z', '[]'),
      ('thread-a', 'turn-a3', 'm-a3', 'running', '2026-09-30T18:30:00.000Z',
        '2026-09-30T18:30:00.000Z', NULL, '[]'),
      ('thread-auto', 'turn-auto', 'm-auto', 'completed', '2026-09-30T14:00:00.000Z',
        '2026-09-30T14:00:00.000Z', '2026-09-30T14:05:00.000Z', '[]')
  `;
  // thread-a's counter reached 50k yesterday; today's first delta must be 30k.
  yield* sql`
    INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
    )
    VALUES
      ('x-a0', 'thread-a', 'turn-a0', 'info', 'context-window.updated', 'tokens',
        '{"provider":"codex","totalProcessedTokens":50000}', 1, '2026-09-29T20:05:00.000Z'),
      ('x-a1', 'thread-a', 'turn-a1', 'info', 'context-window.updated', 'tokens',
        '{"provider":"codex","totalProcessedTokens":80000}', 2, '2026-09-30T05:05:00.000Z'),
      ('x-a2', 'thread-a', 'turn-a2', 'info', 'context-window.updated', 'tokens',
        '{"provider":"codex","totalProcessedTokens":90000}', 3, '2026-09-30T13:10:00.000Z'),
      ('x-auto', 'thread-auto', 'turn-auto', 'info', 'context-window.updated', 'tokens',
        '{"provider":"codex","totalProcessedTokens":7000}', 1, '2026-09-30T14:02:00.000Z')
  `;
});

describe("resolveRecapRanges", () => {
  it("returns the window and its slots", () => {
    const ranges = resolveRecapRanges(RECAP_INPUT);

    expect("error" in ranges).toBe(false);
    if ("error" in ranges) return;
    expect(ranges.window).toMatchObject({
      from: "2026-09-30T04:00:00.000Z",
      to: "2026-10-01T04:00:00.000Z",
    });
    expect(ranges.slots.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: "2026-09-30T04:00:00.000Z", to: "2026-09-30T12:00:00.000Z" },
      { from: "2026-09-30T12:00:00.000Z", to: "2026-09-30T18:00:00.000Z" },
      { from: "2026-09-30T18:00:00.000Z", to: "2026-10-01T04:00:00.000Z" },
    ]);
  });

  it("accepts a day split by hour", () => {
    const from = Date.parse(RECAP_INPUT.from);
    const hourly = Array.from({ length: 23 }, (_, index) =>
      new Date(from + (index + 1) * 3_600_000).toISOString(),
    );
    const ranges = resolveRecapRanges({ ...RECAP_INPUT, slotBoundaries: hourly });

    expect("slots" in ranges ? ranges.slots.length : 0).toBe(24);
  });

  it("refuses reversed windows, windows over 48 hours, and unordered boundaries", () => {
    expect(resolveRecapRanges({ ...RECAP_INPUT, to: RECAP_INPUT.from })).toHaveProperty("error");
    expect(resolveRecapRanges({ ...RECAP_INPUT, to: "2026-10-03T04:00:00.000Z" })).toEqual({
      error: "The recap window can span at most 48 hours.",
    });
    expect(
      resolveRecapRanges({
        ...RECAP_INPUT,
        slotBoundaries: ["2026-09-30T18:00:00.000Z", "2026-09-30T12:00:00.000Z"],
      }),
    ).toHaveProperty("error");
  });
});

describe("recapModelName", () => {
  it("folds a model's dated and context-window ids into one name", () => {
    expect(recapModelName("claudeAgent", "claude-sonnet-5-20260801")).toBe("claude-sonnet-5");
    expect(recapModelName("claudeAgent", "claude-opus-4-1[1m]")).toBe("claude-opus-4-1");
    expect(recapModelName("codex", "gpt-5-codex")).toBe("gpt-5-codex");
    expect(recapModelName("unknown", "  ")).toBe("unknown");
  });
});

describe("RecapStatsQuery", () => {
  it("recaps prompts, turns, agent time, and tokens per slot", async () => {
    const recap = await runRecapTest(
      Effect.gen(function* () {
        yield* seedDay;
        return yield* (yield* RecapStatsQuery).getRecap(RECAP_INPUT);
      }),
    );

    expect(recap.totals).toEqual({
      from: "2026-09-30T04:00:00.000Z",
      to: "2026-10-01T04:00:00.000Z",
      prompts: 5,
      chats: 2,
      turns: 4,
      failedTurns: 1,
      agentWorkMs: 75 * 60_000,
      tokens: { user: 40_000, automation: 7_000, agent: 0 },
    });
    expect(
      recap.slots.map(({ prompts, chats, turns, failedTurns, agentWorkMs, tokens }) => ({
        prompts,
        chats,
        turns,
        failedTurns,
        agentWorkMs,
        tokens,
      })),
    ).toEqual([
      {
        prompts: 3,
        chats: 2,
        turns: 1,
        failedTurns: 0,
        agentWorkMs: 10 * 60_000,
        tokens: { user: 30_000, automation: 0, agent: 0 },
      },
      {
        prompts: 1,
        chats: 1,
        turns: 2,
        failedTurns: 1,
        agentWorkMs: 35 * 60_000,
        tokens: { user: 10_000, automation: 7_000, agent: 0 },
      },
      // The running turn counts up to "now" (19:00).
      {
        prompts: 1,
        chats: 1,
        turns: 1,
        failedTurns: 0,
        agentWorkMs: 30 * 60_000,
        tokens: { user: 0, automation: 0, agent: 0 },
      },
    ]);
    // The per-chat container project never ranks.
    expect(recap.projects).toEqual([
      { projectId: "project-app", title: "App", prompts: 3, chats: 1, tokens: 47_000 },
    ]);
    expect(recap.models).toEqual([
      { provider: "codex", model: "gpt-5-codex", turns: 4, tokens: 47_000 },
    ]);
    expect(recap.unavailableProviders).toEqual([]);
  });

  it("attributes instance-only turns to the session driver alongside their token usage", async () => {
    const recap = await runRecapTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedDay;
        yield* sql`
          UPDATE projection_threads
          SET model_selection_json = '{"instanceId":"work-account","model":"openai/gpt-5"}'
          WHERE thread_id = 'thread-a'
        `;
        yield* sql`
          UPDATE orchestration_events
          SET payload_json = json_set(payload_json, '$.modelSelection',
            json('{"instanceId":"work-account","model":"openai/gpt-5"}'))
          WHERE stream_id = 'thread-a'
        `;
        yield* sql`
          INSERT INTO projection_thread_sessions
            (thread_id, status, provider_name, provider_instance_id, updated_at)
          VALUES ('thread-a', 'ready', 'pi', 'work-account', '2026-09-30T18:30:00.000Z')
        `;
        yield* sql`
          UPDATE projection_thread_activities
          SET payload_json = json_set(payload_json, '$.provider', 'pi')
          WHERE thread_id = 'thread-a'
        `;
        return yield* (yield* RecapStatsQuery).getRecap(RECAP_INPUT);
      }),
    );

    expect(recap.models).toEqual([
      { provider: "pi", model: "openai/gpt-5", turns: 3, tokens: 40_000 },
      { provider: "codex", model: "gpt-5-codex", turns: 1, tokens: 7_000 },
    ]);
    expect(recap.unavailableProviders).toEqual([]);
  });

  it("counts long-running turns, folds dated models, and skips subagent threads", async () => {
    const recap = await runRecapTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, scripts_json, kind, created_at, updated_at, deleted_at
          )
          VALUES ('project-app', 'App', '/work/app', '{}', 'project',
            '2026-09-01T09:00:00.000Z', '2026-09-01T09:00:00.000Z', NULL)
        `;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, env_mode, creation_source, created_at, updated_at, deleted_at
          )
          VALUES
            ('thread-long', 'project-app', 'Long run', '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access', 'default', 'local', NULL,
              '2026-09-30T03:00:00.000Z', '2026-09-30T03:00:00.000Z', NULL),
            ('thread-open', 'project-app', 'Open code', '{"provider":"opencode","model":"kimi-k2"}',
              'full-access', 'default', 'local', NULL,
              '2026-09-30T10:00:00.000Z', '2026-09-30T10:00:00.000Z', NULL),
            ('thread-claude', 'project-app', 'Claude', '{"provider":"claudeAgent","model":"claude-sonnet-5"}',
              'full-access', 'default', 'local', NULL,
              '2026-09-30T15:00:00.000Z', '2026-09-30T15:10:00.000Z', NULL),
            ('thread-child', 'project-app', 'Subagent', '{"provider":"claudeAgent","model":"claude-sonnet-5"}',
              'full-access', 'default', 'local', 'provider_native',
              '2026-09-30T15:00:00.000Z', '2026-09-30T15:10:00.000Z', NULL)
        `;
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, state, requested_at, started_at, completed_at,
            checkpoint_files_json
          )
          VALUES
            ('thread-long', 'turn-long', NULL, 'running', '2026-09-30T03:00:00.000Z',
              '2026-09-30T03:00:00.000Z', NULL, '[]'),
            ('thread-open', 'turn-open', NULL, 'error', '2026-09-30T10:00:00.000Z',
              '2026-09-30T10:00:00.000Z', '2026-09-30T10:00:05.000Z', '[]'),
            ('thread-claude', 'turn-claude', NULL, 'completed', '2026-09-30T15:00:00.000Z',
              '2026-09-30T15:00:00.000Z', '2026-09-30T15:10:00.000Z', '[]'),
            ('thread-child', 'turn-child', NULL, 'completed', '2026-09-30T15:00:00.000Z',
              '2026-09-30T15:00:00.000Z', '2026-09-30T15:10:00.000Z', '[]')
        `;
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          )
          VALUES
            ('x-claude', 'thread-claude', 'turn-claude', 'info', 'turn.completed', 'done',
              '{"provider":"claudeAgent","tokenAccountingVersion":1,"mainLoopTokens":150,"modelUsage":{"claude-sonnet-5-20260801":{"totalTokens":150}}}',
              1, '2026-09-30T15:10:00.000Z')
        `;
        return yield* (yield* RecapStatsQuery).getRecap(RECAP_INPUT);
      }),
    );

    // turn-long runs from 04:00 to now (19:00); the errored turn adds 5 s and the
    // Claude turn 10 min. The subagent's turn adds neither time nor a turn.
    expect(recap.totals).toMatchObject({
      turns: 2,
      failedTurns: 1,
      agentWorkMs: 15 * 3_600_000 + 5_000 + 10 * 60_000,
    });
    expect(recap.slots.map((slot) => slot.agentWorkMs)).toEqual([
      8 * 3_600_000 + 5_000,
      6 * 3_600_000 + 10 * 60_000,
      3_600_000,
    ]);
    expect(recap.models).toEqual([
      { provider: "claudeAgent", model: "claude-sonnet-5", turns: 1, tokens: 150 },
      { provider: "opencode", model: "kimi-k2", turns: 1, tokens: 0 },
    ]);
    // A turn that failed before reporting usage does not mark its provider as silent.
    expect(recap.unavailableProviders).toEqual([]);
  });

  it("refuses the recap when the Inbox is off for this build", async () => {
    const error = await runRecapTest(
      Effect.gen(function* () {
        return yield* Effect.flip((yield* RecapStatsQuery).getRecap(RECAP_INPUT));
      }),
      { isInboxEnabled: () => false },
    );

    expect(error).toMatchObject({ code: "FEATURE_UNAVAILABLE", retryable: false });
  });
});
