// FILE: profileStatsArchive.test.ts
// Purpose: Coverage for the snapshot-then-purge flow: purging a thread must
// free its rows while leaving every Profile stat unchanged.
// Layer: Server stats tests
// Exports: Vitest coverage for ProfileStatsArchive.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "./config";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import { ProfileStatsQuery, ProfileStatsQueryLive } from "./profileStats";
import { ProfileStatsArchive, ProfileStatsArchiveLive } from "./profileStatsArchive";

const testLayer = Layer.mergeAll(ProfileStatsQueryLive, ProfileStatsArchiveLive).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "synara-profile-stats-archive-test-",
    }),
  ),
  Layer.provide(NodeServices.layer),
);

function runArchiveTest<A, E>(
  effect: Effect.Effect<A, E, ProfileStatsQuery | ProfileStatsArchive | SqlClient.SqlClient>,
) {
  return effect.pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);
}

const seedTwoThreadsWithActivity = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    )
    VALUES (
      'project-archive',
      'Archive',
      '/work/archive',
      '{}',
      '2026-06-12T09:00:00.000Z',
      '2026-06-12T09:00:00.000Z',
      NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, env_mode, created_at, updated_at, deleted_at
    )
    VALUES
      (
        'thread-keep',
        'project-archive',
        'Kept Thread',
        '{"provider":"claudeAgent","model":"claude-sonnet-4-6","options":{"effort":"max"}}',
        'full-access', 'default', 'local',
        '2026-06-13T08:00:00.000Z', '2026-06-13T08:00:00.000Z', NULL
      ),
      (
        'thread-purge',
        'project-archive',
        'Purged Thread',
        '{"provider":"codex","model":"gpt-5-codex","options":{"reasoningEffort":"high"}}',
        'full-access', 'default', 'local',
        '2026-06-13T09:00:00.000Z', '2026-06-13T09:00:00.000Z', NULL
      )
  `;

  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, skills_json, mentions_json,
      is_streaming, source, created_at, updated_at
    )
    VALUES
      (
        'message-keep-1', 'thread-keep', 'turn-keep-1', 'user',
        'keep one', NULL, NULL,
        0, 'native', '2026-06-13T08:05:00.000Z', '2026-06-13T08:05:00.000Z'
      ),
      (
        'message-purge-1', 'thread-purge', 'turn-purge-1', 'user',
        'Use /check-code here',
        '[{"name":"check-code","path":"/skills/check-code/SKILL.md"}]', NULL,
        0, 'native', '2026-06-13T09:05:00.000Z', '2026-06-13T09:05:00.000Z'
      ),
      (
        'message-purge-2', 'thread-purge', 'turn-purge-2', 'user',
        'purge two', NULL, '[{"name":"reviewer","path":"agent://reviewer"}]',
        0, 'native', '2026-06-14T10:05:00.000Z', '2026-06-14T10:05:00.000Z'
      )
  `;

  yield* sql`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type,
      occurred_at, actor_kind, payload_json, metadata_json
    )
    VALUES
      (
        'event-keep-1', 'thread', 'thread-keep', 1, 'thread.turn-start-requested',
        '2026-06-13T08:05:00.000Z', 'client',
        '{"threadId":"thread-keep","modelSelection":{"provider":"claudeAgent","model":"claude-sonnet-4-6","options":{"effort":"max"}}}',
        '{}'
      ),
      (
        'event-purge-1', 'thread', 'thread-purge', 1, 'thread.turn-start-requested',
        '2026-06-13T09:05:00.000Z', 'client',
        '{"threadId":"thread-purge","modelSelection":{"provider":"codex","model":"gpt-5-codex","options":{"reasoningEffort":"high"}}}',
        '{}'
      ),
      (
        'event-purge-2', 'thread', 'thread-purge', 2, 'thread.turn-start-requested',
        '2026-06-14T10:05:00.000Z', 'client',
        '{"threadId":"thread-purge"}',
        '{}'
      )
  `;

  yield* sql`
    INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
    )
    VALUES
      (
        'activity-keep-1', 'thread-keep', 'turn-keep-1', 'info',
        'context-window.updated', 'tokens updated',
        '{"totalProcessedTokens":1000}', 1, '2026-06-13T08:06:00.000Z'
      ),
      (
        'activity-purge-1', 'thread-purge', 'turn-purge-1', 'info',
        'context-window.updated', 'tokens updated',
        '{"totalProcessedTokens":3000}', 1, '2026-06-13T09:06:00.000Z'
      ),
      (
        'activity-purge-2', 'thread-purge', 'turn-purge-2', 'info',
        'context-window.updated', 'tokens updated',
        '{"totalProcessedTokens":5000}', 2, '2026-06-13T18:45:00.000Z'
      )
  `;
});

describe("ProfileStatsArchive", () => {
  it("purges a thread's rows while keeping every profile stat unchanged", async () => {
    await runArchiveTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;
        const archive = yield* ProfileStatsArchive;

        yield* seedTwoThreadsWithActivity;

        const statsBefore = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });
        const tokenStatsBefore = yield* statsQuery.getProfileTokenStats({ utcOffsetMinutes: 0 });
        // Half-hour offset: the 18:45Z token activity lands on the NEXT local
        // day for +05:30, so this catches any archive-side day re-bucketing drift.
        const statsBeforeIst = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 330 });
        const tokenStatsBeforeIst = yield* statsQuery.getProfileTokenStats({
          utcOffsetMinutes: 330,
        });

        const purged = yield* archive.purgeThreadWithStatsSnapshot({ threadId: "thread-purge" });
        expect(purged).toBe(true);

        // Every row the purged thread owned is gone.
        const remaining = yield* sql<{ readonly threads: number; readonly messages: number }>`
          SELECT
            (SELECT COUNT(*) FROM projection_threads WHERE thread_id = 'thread-purge') AS threads,
            (SELECT COUNT(*) FROM projection_thread_messages WHERE thread_id = 'thread-purge')
              AS messages
        `;
        expect(remaining[0]).toMatchObject({ threads: 0, messages: 0 });
        const remainingEvents = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM orchestration_events WHERE stream_id = 'thread-purge'
        `;
        expect(remainingEvents[0]?.count).toBe(0);
        const remainingActivities = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM projection_thread_activities
          WHERE thread_id = 'thread-purge'
        `;
        expect(remainingActivities[0]?.count).toBe(0);

        // The Profile numbers do not move: the archive snapshot replaces the rows.
        const statsAfter = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });
        const tokenStatsAfter = yield* statsQuery.getProfileTokenStats({ utcOffsetMinutes: 0 });
        expect(statsAfter.activity).toEqual(statsBefore.activity);
        expect(statsAfter.activeHours).toEqual(statsBefore.activeHours);
        expect(statsAfter.insights).toEqual(statsBefore.insights);
        expect(statsAfter.providerModels).toEqual(statsBefore.providerModels);
        expect(statsAfter.skills).toEqual(statsBefore.skills);
        expect(statsAfter.mostWorkedProject).toEqual(statsBefore.mostWorkedProject);
        expect(tokenStatsAfter).toEqual(tokenStatsBefore);

        const statsAfterIst = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 330 });
        const tokenStatsAfterIst = yield* statsQuery.getProfileTokenStats({
          utcOffsetMinutes: 330,
        });
        expect(statsAfterIst.activity).toEqual(statsBeforeIst.activity);
        expect(statsAfterIst.activeHours).toEqual(statsBeforeIst.activeHours);
        expect(tokenStatsAfterIst).toEqual(tokenStatsBeforeIst);

        // Re-purging an already purged thread is a no-op.
        const purgedAgain = yield* archive.purgeThreadWithStatsSnapshot({
          threadId: "thread-purge",
        });
        expect(purgedAgain).toBe(false);
        const statsAfterRepurge = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });
        expect(statsAfterRepurge.activity).toEqual(statsBefore.activity);
      }),
    );
  });

  it("sweeps manually soft-deleted threads but leaves retention-hidden ones in place", async () => {
    await runArchiveTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;
        const archive = yield* ProfileStatsArchive;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, env_mode, created_at, updated_at, deleted_at
          )
          VALUES
            (
              'thread-live', 'project-sweep', 'Live', '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access', 'default', 'local',
              '2026-06-13T09:00:00.000Z', '2026-06-13T09:00:00.000Z', NULL
            ),
            (
              'thread-manual', 'project-sweep', 'Manual',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access', 'default', 'local',
              '2026-06-13T09:00:00.000Z', '2026-06-13T09:00:00.000Z', '2026-06-15T10:00:00.000Z'
            ),
            (
              'thread-retention', 'project-sweep', 'Retention',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access', 'default', 'local',
              '2026-06-08T09:00:00.000Z', '2026-06-08T09:00:00.000Z', '2026-06-15T09:00:00.000Z'
            )
        `;

        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming, source,
            created_at, updated_at
          )
          VALUES
            (
              'message-manual-1', 'thread-manual', 'turn-manual-1', 'user', 'manual work',
              0, 'native', '2026-06-13T09:05:00.000Z', '2026-06-13T09:05:00.000Z'
            ),
            (
              'message-retention-1', 'thread-retention', 'turn-retention-1', 'user',
              'retention work',
              0, 'native', '2026-06-08T09:05:00.000Z', '2026-06-08T09:05:00.000Z'
            )
        `;

        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, command_id, actor_kind, payload_json, metadata_json
          )
          VALUES
            (
              'event-manual-delete', 'thread', 'thread-manual', 1, 'thread.deleted',
              '2026-06-15T10:00:00.000Z', 'manual-delete:sweep-test', 'user',
              '{"threadId":"thread-manual","deletedAt":"2026-06-15T10:00:00.000Z"}', '{}'
            ),
            (
              'event-retention-delete', 'thread', 'thread-retention', 1, 'thread.deleted',
              '2026-06-15T09:00:00.000Z', 'thread-retention:sweep-test', 'system',
              '{"threadId":"thread-retention","deletedAt":"2026-06-15T09:00:00.000Z"}', '{}'
            )
        `;

        const statsBefore = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });
        expect(statsBefore.activity.totalPromptsSent).toBe(2);
        expect(statsBefore.activity.totalThreads).toBe(3);

        const purgedCount = yield* archive.purgeSoftDeletedManualThreads();
        expect(purgedCount).toBe(1);

        const threadRows = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS threadId FROM projection_threads ORDER BY thread_id ASC
        `;
        expect(threadRows.map((row) => row.threadId)).toEqual(["thread-live", "thread-retention"]);
        const tombstones = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS threadId FROM profile_stats_deleted_threads
        `;
        expect(tombstones.map((row) => row.threadId)).toEqual(["thread-manual"]);

        // Lifetime totals survive: retention rows stay live, manual work is archived.
        const statsAfter = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });
        expect(statsAfter.activity.totalPromptsSent).toBe(2);
        expect(statsAfter.activity.totalThreads).toBe(3);
      }),
    );
  });
});
