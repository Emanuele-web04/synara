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
import {
  aggregateProfileSkillUsageRows,
  ProfileStatsQuery,
  ProfileStatsQueryLive,
} from "./profileStats";

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
  it("normalizes profile skill usage from structured refs plus slash and dollar prompt tokens", () => {
    expect(
      aggregateProfileSkillUsageRows([
        {
          messageId: "message-1",
          text: "Use $check-code and /refactor-code",
          skillsJson: JSON.stringify([
            { name: "check-code", path: "/skills/check-code/SKILL.md" },
            { name: "refactor-code", path: "/skills/refactor-code/SKILL.md" },
          ]),
          mentionsJson: null,
        },
        {
          messageId: "message-2",
          text: "Use /check-code again, but keep /plan plain, ignore /Users/test and $PATH",
          skillsJson: null,
          mentionsJson: JSON.stringify([{ name: "reviewer", path: "agent://reviewer" }]),
        },
        {
          messageId: "message-3",
          text: "Pi style /skill:planner should group as planner; shell $HOME and cost $100 do not",
          skillsJson: null,
          mentionsJson: null,
        },
      ]),
    ).toEqual([
      { name: "check-code", displayName: "$check-code", kind: "skill", runCount: 2 },
      { name: "planner", displayName: "$planner", kind: "skill", runCount: 1 },
      { name: "refactor-code", displayName: "$refactor-code", kind: "skill", runCount: 1 },
      { name: "reviewer", displayName: "@reviewer", kind: "agent", runCount: 1 },
    ]);
  });

  it("counts repeated slash and dollar skill tokens without double-counting structured echoes", () => {
    expect(
      aggregateProfileSkillUsageRows([
        {
          messageId: "message-repeat",
          text: "Use $check-code, /check-code, and /logic-consolidator /logic-consolidator",
          skillsJson: JSON.stringify([
            { name: "check-code", path: "/skills/check-code/SKILL.md" },
            { name: "logic-consolidator", path: "/skills/logic-consolidator/SKILL.md" },
          ]),
          mentionsJson: null,
        },
      ]),
    ).toEqual([
      { name: "check-code", displayName: "$check-code", kind: "skill", runCount: 2 },
      {
        name: "logic-consolidator",
        displayName: "$logic-consolidator",
        kind: "skill",
        runCount: 2,
      },
    ]);
  });

  it("does not count serialized prompt block closing tags as slash skills", () => {
    expect(
      aggregateProfileSkillUsageRows([
        {
          messageId: "message-blocks",
          text: [
            "Use /check-code for the actual request.",
            "<terminal_context>",
            "npm test",
            "</terminal_context>",
            "<file_comments>",
            "src/app.ts: leave this as-is",
            "</file_comments>",
            "<pasted_text>",
            '[{"text":"const value = $foo;\\nrun /deploy now"}]',
            "</pasted_text>",
          ].join("\n"),
          skillsJson: null,
          mentionsJson: null,
        },
      ]),
    ).toEqual([{ name: "check-code", displayName: "$check-code", kind: "skill", runCount: 1 }]);
  });

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

  it("reports token-based provider ranking separately from turn-count profile stats", async () => {
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
              '{"provider":"codex","model":"gpt-5-codex"}',
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
              '{"provider":"claudeAgent","model":"claude-sonnet-4-6"}',
              'full-access',
              'default',
              'local',
              '2026-06-13T10:00:00.000Z',
              '2026-06-13T10:00:00.000Z',
              NULL
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
              '{"threadId":"thread-codex","modelSelection":{"provider":"codex","model":"gpt-5-codex"}}',
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
              '{"threadId":"thread-codex","modelSelection":{"provider":"codex","model":"gpt-5-codex"}}',
              '{}'
            ),
            (
              'event-claude-1',
              'thread',
              'thread-claude',
              1,
              'thread.turn-start-requested',
              '2026-06-13T10:05:00.000Z',
              'client',
              '{"threadId":"thread-claude","modelSelection":{"provider":"claudeAgent","model":"claude-sonnet-4-6"}}',
              '{}'
            )
        `;

        // Codex has more turns (2 vs 1) but Claude processed far more tokens,
        // so core stats stay turn-ranked while token stats report Claude on top.
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
              'activity-codex-1',
              'thread-codex',
              'turn-codex-1',
              'info',
              'context-window.updated',
              'tokens updated',
              '{"totalProcessedTokens":1000}',
              1,
              '2026-06-13T09:06:00.000Z'
            ),
            (
              'activity-claude-1',
              'thread-claude',
              'turn-claude-1',
              'info',
              'context-window.updated',
              'tokens updated',
              '{"totalProcessedTokens":5000}',
              1,
              '2026-06-13T10:06:00.000Z'
            )
        `;

        const stats = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });
        const tokenStats = yield* statsQuery.getProfileTokenStats({ utcOffsetMinutes: 0 });

        expect(stats.insights.topProvider).toBe("codex");
        expect(stats.insights.topProviderPercent).toBeCloseTo(66.7);
        expect(tokenStats.topProvider).toBe("claudeAgent");
        expect(tokenStats.topProviderPercent).toBeCloseTo(83.3);
        expect(tokenStats.providers).toEqual(["claudeAgent", "codex"]);
        // Turn-based provider/model mix is unchanged by the token ranking.
        expect(stats.providerModels[0]).toMatchObject({ provider: "codex", turnCount: 2 });
      }),
    );
  });

  it("counts slash skill invocations from projected thread message text and groups them with dollar usage", async () => {
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
              'thread-skills',
              'project-profile',
              'Skill Thread',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access',
              'default',
              'local',
              '2026-06-14T09:00:00.000Z',
              '2026-06-14T09:00:00.000Z',
              NULL
            ),
            (
              'thread-retention-hidden',
              'project-profile',
              'Retention Hidden Skill Thread',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access',
              'default',
              'local',
              '2026-06-08T09:00:00.000Z',
              '2026-06-08T09:00:00.000Z',
              '2026-06-15T09:00:00.000Z'
            ),
            (
              'thread-manual-deleted',
              'project-profile',
              'Manual Deleted Skill Thread',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access',
              'default',
              'local',
              '2026-06-08T10:00:00.000Z',
              '2026-06-08T10:00:00.000Z',
              '2026-06-15T10:00:00.000Z'
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
            command_id,
            actor_kind,
            payload_json,
            metadata_json
          )
          VALUES
            (
              'event-retention-hidden-delete',
              'thread',
              'thread-retention-hidden',
              1,
              'thread.deleted',
              '2026-06-15T09:00:00.000Z',
              'thread-retention:test-hidden',
              'system',
              '{"threadId":"thread-retention-hidden","deletedAt":"2026-06-15T09:00:00.000Z"}',
              '{}'
            ),
            (
              'event-manual-delete',
              'thread',
              'thread-manual-deleted',
              1,
              'thread.deleted',
              '2026-06-15T10:00:00.000Z',
              'manual-delete:test-hidden',
              'user',
              '{"threadId":"thread-manual-deleted","deletedAt":"2026-06-15T10:00:00.000Z"}',
              '{}'
            )
        `;

        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id,
            thread_id,
            turn_id,
            role,
            text,
            skills_json,
            mentions_json,
            is_streaming,
            source,
            created_at,
            updated_at
          )
          VALUES
            (
              'message-skill-1',
              'thread-skills',
              'turn-skill-1',
              'user',
              'Use $check-code and /refactor-code',
              '[{"name":"check-code","path":"/skills/check-code/SKILL.md"},{"name":"refactor-code","path":"/skills/refactor-code/SKILL.md"}]',
              NULL,
              0,
              'native',
              '2026-06-14T09:05:00.000Z',
              '2026-06-14T09:05:00.000Z'
            ),
            (
              'message-skill-2',
              'thread-skills',
              'turn-skill-2',
              'user',
              'Use /check-code and /skill:planner, ignore /plan, /Users/test, $PATH, and $100',
              NULL,
              '[{"name":"reviewer","path":"agent://reviewer"}]',
              0,
              'native',
              '2026-06-14T09:35:00.000Z',
              '2026-06-14T09:35:00.000Z'
            ),
            (
              'message-skill-retention-hidden',
              'thread-retention-hidden',
              'turn-skill-retention-hidden',
              'user',
              'Retention-hidden /check-code and $check-code should still count',
              '[{"name":"check-code","path":"/skills/check-code/SKILL.md"}]',
              NULL,
              0,
              'native',
              '2026-06-08T09:05:00.000Z',
              '2026-06-08T09:05:00.000Z'
            ),
            (
              'message-skill-manual-deleted',
              'thread-manual-deleted',
              'turn-skill-manual-deleted',
              'user',
              'Manual deleted /openai-docs should still count',
              '[{"name":"openai-docs","path":"/skills/openai-docs/SKILL.md"}]',
              NULL,
              0,
              'native',
              '2026-06-08T10:05:00.000Z',
              '2026-06-08T10:05:00.000Z'
            ),
            (
              'message-skill-import',
              'thread-skills',
              'turn-skill-import',
              'user',
              'Imported /imported-skill should not count',
              '[{"name":"imported-skill","path":"/skills/imported-skill/SKILL.md"}]',
              NULL,
              0,
              'handoff-import',
              '2026-06-14T09:45:00.000Z',
              '2026-06-14T09:45:00.000Z'
            )
        `;

        const stats = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });

        // Retention-hidden and manually deleted threads both keep contributing:
        // profile stats are lifetime totals and deletion is only a soft hide.
        expect(stats.insights.skillsExplored).toBe(5);
        expect(stats.insights.totalSkillsUsed).toBe(8);
        expect(stats.activity.totalPromptsSent).toBe(4);
        expect(stats.activity.totalThreads).toBe(3);
        expect(stats.skills.slice(0, 5)).toEqual([
          { name: "check-code", displayName: "$check-code", kind: "skill", runCount: 4 },
          { name: "openai-docs", displayName: "$openai-docs", kind: "skill", runCount: 1 },
          { name: "planner", displayName: "$planner", kind: "skill", runCount: 1 },
          { name: "refactor-code", displayName: "$refactor-code", kind: "skill", runCount: 1 },
          { name: "reviewer", displayName: "@reviewer", kind: "agent", runCount: 1 },
        ]);
      }),
    );
  });

  it("keeps deleted threads and deleted projects in the most-worked ranking", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        yield* sql`
          INSERT INTO projection_projects (
            project_id,
            title,
            workspace_root,
            scripts_json,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES
            (
              'project-alpha',
              'Alpha',
              '/work/alpha',
              '{}',
              '2026-06-12T09:00:00.000Z',
              '2026-06-12T09:00:00.000Z',
              NULL
            ),
            (
              'project-beta',
              'Beta',
              '/work/beta',
              '{}',
              '2026-06-12T09:00:00.000Z',
              '2026-06-12T09:00:00.000Z',
              NULL
            ),
            (
              'project-deleted',
              'Deleted',
              '/work/deleted',
              '{}',
              '2026-06-12T09:00:00.000Z',
              '2026-06-12T09:00:00.000Z',
              '2026-06-14T09:00:00.000Z'
            )
        `;

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
              'thread-alpha',
              'project-alpha',
              'Alpha Thread',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access',
              'default',
              'local',
              '2026-06-13T09:00:00.000Z',
              '2026-06-13T09:00:00.000Z',
              NULL
            ),
            (
              'thread-beta',
              'project-beta',
              'Beta Thread',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access',
              'default',
              'local',
              '2026-06-13T09:00:00.000Z',
              '2026-06-13T09:00:00.000Z',
              NULL
            ),
            (
              'thread-alpha-deleted',
              'project-alpha',
              'Deleted Alpha Thread',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access',
              'default',
              'local',
              '2026-06-13T09:00:00.000Z',
              '2026-06-13T09:00:00.000Z',
              '2026-06-14T09:00:00.000Z'
            ),
            (
              'thread-deleted-project',
              'project-deleted',
              'Deleted Project Thread',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access',
              'default',
              'local',
              '2026-06-13T09:00:00.000Z',
              '2026-06-13T09:00:00.000Z',
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
              'message-alpha-1',
              'thread-alpha',
              'turn-alpha-1',
              'user',
              'alpha one',
              0,
              'native',
              '2026-06-13T09:05:00.000Z',
              '2026-06-13T09:05:00.000Z'
            ),
            (
              'message-alpha-2',
              'thread-alpha',
              'turn-alpha-2',
              'user',
              'alpha two',
              0,
              'native',
              '2026-06-13T09:35:00.000Z',
              '2026-06-13T09:35:00.000Z'
            ),
            (
              'message-beta-1',
              'thread-beta',
              'turn-beta-1',
              'user',
              'beta one',
              0,
              'native',
              '2026-06-13T10:05:00.000Z',
              '2026-06-13T10:05:00.000Z'
            ),
            (
              'message-beta-2',
              'thread-beta',
              'turn-beta-2',
              'user',
              'beta two',
              0,
              'native',
              '2026-06-14T10:05:00.000Z',
              '2026-06-14T10:05:00.000Z'
            ),
            (
              'message-beta-3',
              'thread-beta',
              'turn-beta-3',
              'user',
              'beta three',
              0,
              'native',
              '2026-06-14T10:35:00.000Z',
              '2026-06-14T10:35:00.000Z'
            ),
            (
              'message-alpha-deleted-thread',
              'thread-alpha-deleted',
              'turn-alpha-deleted',
              'user',
              'deleted thread still counts',
              0,
              'native',
              '2026-06-14T11:05:00.000Z',
              '2026-06-14T11:05:00.000Z'
            ),
            (
              'message-deleted-project',
              'thread-deleted-project',
              'turn-deleted-project',
              'user',
              'deleted project still counts',
              0,
              'native',
              '2026-06-14T11:35:00.000Z',
              '2026-06-14T11:35:00.000Z'
            )
        `;

        const stats = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });

        // Lifetime totals: deleted threads/projects keep their contribution.
        expect(stats.activity.totalPromptsSent).toBe(7);
        expect(stats.activity.totalThreads).toBe(4);
        // Alpha and Beta tie on prompts (3) and active days (2); the deleted
        // Alpha thread's later prompt breaks the tie via lastWorkedAt.
        expect(stats.mostWorkedProject).toEqual({
          projectId: "project-alpha",
          title: "Alpha",
          workspaceRoot: "/work/alpha",
          promptCount: 3,
          threadCount: 2,
          activeDays: 2,
          lastWorkedAt: "2026-06-14T11:05:00.000Z",
        });
      }),
    );
  });

  it("computes longest streak from all prompt days instead of only the heatmap window", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        yield* sql`
          INSERT INTO projection_projects (
            project_id,
            title,
            workspace_root,
            scripts_json,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES (
            'project-streak',
            'Streak',
            '/work/streak',
            '{}',
            '2025-01-01T09:00:00.000Z',
            '2025-01-01T09:00:00.000Z',
            NULL
          )
        `;

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
            'thread-streak',
            'project-streak',
            'Streak Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            'local',
            '2025-01-01T09:00:00.000Z',
            '2025-01-03T09:00:00.000Z',
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
              'message-streak-1',
              'thread-streak',
              'turn-streak-1',
              'user',
              'day one',
              0,
              'native',
              '2025-01-01T09:05:00.000Z',
              '2025-01-01T09:05:00.000Z'
            ),
            (
              'message-streak-2',
              'thread-streak',
              'turn-streak-2',
              'user',
              'day two',
              0,
              'native',
              '2025-01-02T09:05:00.000Z',
              '2025-01-02T09:05:00.000Z'
            ),
            (
              'message-streak-3',
              'thread-streak',
              'turn-streak-3',
              'user',
              'day three',
              0,
              'native',
              '2025-01-03T09:05:00.000Z',
              '2025-01-03T09:05:00.000Z'
            )
        `;

        const stats = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });

        expect(stats.activity.totalPromptsSent).toBe(3);
        expect(stats.activity.longestStreakDays).toBe(3);
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
