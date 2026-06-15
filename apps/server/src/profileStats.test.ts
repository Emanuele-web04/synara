// FILE: profileStats.test.ts
// Purpose: Focused coverage for Profile stats SQL aggregation against the migrated SQLite schema.
// Layer: Server stats tests
// Exports: Vitest coverage for ProfileStatsQuery.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "./config";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import { ProfileStatsQuery, ProfileStatsQueryLive } from "./profileStats";

const testLayer = ProfileStatsQueryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "synara-profile-stats-test-",
    }),
  ),
  Layer.provide(NodeServices.layer),
);

function runProfileStatsTest<A, E>(
  effect: Effect.Effect<A, E, ProfileStatsQuery | SqlClient.SqlClient>,
) {
  return effect.pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);
}

describe("ProfileStatsQuery", () => {
  it("aggregates prompts, model usage, provider usage, and reasoning from local projections", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
            runtime_mode,
            interaction_mode,
            env_mode,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES
            (
              'thread-codex',
              'project-profile',
              'Codex Thread',
              '{"provider":"codex","model":"gpt-5-codex","options":{"reasoningEffort":"high"}}',
              'full-access',
              'default',
              'local',
              '2026-06-13T09:00:00.000Z',
              '2026-06-13T09:00:00.000Z',
              NULL
            ),
            (
              'thread-claude',
              'project-profile',
              'Claude Thread',
              '{"provider":"claudeAgent","model":"claude-sonnet-4-6","options":{"effort":"max"}}',
              'full-access',
              'default',
              'local',
              '2026-06-13T10:00:00.000Z',
              '2026-06-13T10:00:00.000Z',
              NULL
            )
        `;

        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id,
            thread_id,
            turn_id,
            role,
            text,
            is_streaming,
            source,
            created_at,
            updated_at
          )
          VALUES
            (
              'message-codex-1',
              'thread-codex',
              'turn-codex-1',
              'user',
              'first',
              0,
              'native',
              '2026-06-13T09:05:00.000Z',
              '2026-06-13T09:05:00.000Z'
            ),
            (
              'message-codex-2',
              'thread-codex',
              'turn-codex-2',
              'user',
              'second',
              0,
              'native',
              '2026-06-13T09:35:00.000Z',
              '2026-06-13T09:35:00.000Z'
            ),
            (
              'message-claude-1',
              'thread-claude',
              'turn-claude-1',
              'user',
              'third',
              0,
              'native',
              '2026-06-14T10:05:00.000Z',
              '2026-06-14T10:05:00.000Z'
            )
        `;

        yield* sql`
          INSERT INTO orchestration_events (
            event_id,
            aggregate_kind,
            stream_id,
            stream_version,
            event_type,
            occurred_at,
            actor_kind,
            payload_json,
            metadata_json
          )
          VALUES
            (
              'event-codex-1',
              'thread',
              'thread-codex',
              1,
              'thread.turn-start-requested',
              '2026-06-13T09:05:00.000Z',
              'client',
              '{"threadId":"thread-codex","modelSelection":{"provider":"codex","model":"gpt-5-codex","options":{"reasoningEffort":"high"}}}',
              '{}'
            ),
            (
              'event-codex-2',
              'thread',
              'thread-codex',
              2,
              'thread.turn-start-requested',
              '2026-06-13T09:35:00.000Z',
              'client',
              '{"threadId":"thread-codex","modelSelection":{"provider":"codex","model":"gpt-5-codex","options":{"reasoningEffort":"high"}}}',
              '{}'
            ),
            (
              'event-claude-1',
              'thread',
              'thread-claude',
              1,
              'thread.turn-start-requested',
              '2026-06-14T10:05:00.000Z',
              'client',
              '{"threadId":"thread-claude","modelSelection":{"provider":"claudeAgent","model":"claude-sonnet-4-6","options":{"effort":"max"}}}',
              '{}'
            )
        `;

        const stats = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });

        expect(stats.activity.totalPromptsSent).toBe(3);
        expect(stats.activity.totalThreads).toBe(2);
        expect(stats.activeHours.startHour).toBe(9);
        expect(stats.activeHours.turnCount).toBe(2);
        expect(stats.insights.topProvider).toBe("codex");
        expect(stats.insights.topProviderPercent).toBeCloseTo(66.7);
        expect(stats.insights.topReasoning).toBe("high");
        expect(stats.insights.topReasoningPercent).toBeCloseTo(66.7);
        expect(stats.providerModels[0]).toMatchObject({
          provider: "codex",
          model: "gpt-5-codex",
          turnCount: 2,
        });
      }),
    );
  });

  it("keeps token stats available when a legacy thread has malformed model JSON", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
            runtime_mode,
            interaction_mode,
            env_mode,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES (
            'thread-legacy-bad-json',
            'project-profile',
            'Legacy Bad JSON',
            '{bad-json',
            'full-access',
            'default',
            'local',
            '2026-06-14T09:00:00.000Z',
            '2026-06-14T09:00:00.000Z',
            NULL
          )
        `;

        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          )
          VALUES
            (
              'activity-token-1',
              'thread-legacy-bad-json',
              'turn-legacy-1',
              'info',
              'context-window.updated',
              'tokens updated',
              '{"totalProcessedTokens":1000}',
              1,
              '2026-06-14T09:05:00.000Z'
            ),
            (
              'activity-token-2',
              'thread-legacy-bad-json',
              'turn-legacy-1',
              'info',
              'context-window.updated',
              'tokens updated',
              '{"totalProcessedTokens":1500}',
              2,
              '2026-06-14T09:10:00.000Z'
            )
        `;

        const tokenStats = yield* statsQuery.getProfileTokenStats({ utcOffsetMinutes: 0 });

        expect(tokenStats.available).toBe(true);
        expect(tokenStats.lifetimeTotalTokens).toBe(1500);
        expect(tokenStats.providers).toEqual([]);
      }),
    );
  });
});
