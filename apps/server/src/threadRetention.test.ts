// FILE: threadRetention.test.ts
// Purpose: Verifies inactive-thread retention selection without running the server loop.
// Layer: Server maintenance tests
// Exports: Vitest coverage for threadRetention helpers.

import { ProjectId, ThreadId, type OrchestrationReadModel } from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import {
  getInactiveThreadIdsForRetention,
  getSoftDeletedThreadIdsForRetentionPurge,
  purgeThreadDatabaseRows,
  THREAD_RETENTION_UNUSED_MS,
} from "./threadRetention";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";

function makeReadModelThread(
  overrides: Partial<OrchestrationReadModel["threads"][number]> = {},
): OrchestrationReadModel["threads"][number] {
  return {
    id: ThreadId.makeUnsafe("thread-active"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    latestUserMessageAt: null,
    deletedAt: null,
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestTurn: null,
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    ...overrides,
  } as OrchestrationReadModel["threads"][number];
}

function makeReadModel(threads: OrchestrationReadModel["threads"]): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads,
    updatedAt: "2026-04-20T00:00:00.000Z",
  };
}

describe("thread retention", () => {
  it("selects inactive threads older than the seven-day retention window", () => {
    const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
    const staleThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-stale"),
      latestUserMessageAt: new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString(),
    });
    const recentThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-recent"),
      latestUserMessageAt: new Date(nowMs - THREAD_RETENTION_UNUSED_MS + 1).toISOString(),
    });

    expect(
      getInactiveThreadIdsForRetention(makeReadModel([staleThread, recentThread]), nowMs),
    ).toEqual([staleThread.id]);
  });

  it("does not select busy or pending threads even when they are old", () => {
    const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
    const oldActivityAt = new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString();

    expect(
      getInactiveThreadIdsForRetention(
        makeReadModel([
          makeReadModelThread({
            id: ThreadId.makeUnsafe("thread-running"),
            latestUserMessageAt: oldActivityAt,
            session: {
              threadId: ThreadId.makeUnsafe("thread-running"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: oldActivityAt,
            },
          }),
          makeReadModelThread({
            id: ThreadId.makeUnsafe("thread-pending"),
            latestUserMessageAt: oldActivityAt,
            hasPendingUserInput: true,
          }),
        ]),
        nowMs,
      ),
    ).toEqual([]);
  });

  it("selects already deleted threads for physical purge retry", () => {
    const deletedThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-deleted"),
      deletedAt: "2026-04-19T12:00:00.000Z",
    });
    const liveThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-live"),
      deletedAt: null,
    });

    expect(
      getSoftDeletedThreadIdsForRetentionPurge(makeReadModel([deletedThread, liveThread])),
    ).toEqual([deletedThread.id]);
  });
});

const sqliteLayer = effectIt.layer(SqlitePersistenceMemory);

sqliteLayer("thread retention database purge", (it) => {
  it.effect("physically removes retained thread rows while preserving other threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const purgedThreadId = ThreadId.makeUnsafe("thread-purge");
      const keptThreadId = ThreadId.makeUnsafe("thread-keep");
      const now = "2026-04-20T00:00:00.000Z";

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
            ${purgedThreadId},
            'project-1',
            'Thread purge',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            'local',
            ${now},
            ${now},
            ${now}
          ),
          (
            ${keptThreadId},
            'project-1',
            'Thread keep',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            'local',
            ${now},
            ${now},
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
          created_at,
          updated_at
        )
        VALUES
          ('message-purge', ${purgedThreadId}, 'turn-1', 'user', 'old', 0, ${now}, ${now}),
          ('message-keep', ${keptThreadId}, 'turn-2', 'user', 'new', 0, ${now}, ${now})
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
          created_at
        )
        VALUES ('activity-purge', ${purgedThreadId}, 'turn-1', 'info', 'event', 'old', '{}', ${now})
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (${purgedThreadId}, 'stopped', 'codex', 'session-1', 'provider-thread-1', NULL, NULL, ${now})
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          checkpoint_files_json
        )
        VALUES (${purgedThreadId}, 'turn-1', NULL, NULL, 'completed', ${now}, '[]')
      `;
      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          created_at,
          updated_at
        )
        VALUES ('plan-purge', ${purgedThreadId}, 'turn-1', '# Old plan', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id,
          thread_id,
          turn_id,
          status,
          decision,
          created_at,
          resolved_at
        )
        VALUES ('approval-purge', ${purgedThreadId}, 'turn-1', 'pending', NULL, ${now}, NULL)
      `;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES (${purgedThreadId}, 'codex', 'codex', 'full-access', 'stopped', ${now}, NULL, '{}')
      `;
      yield* sql`
        INSERT INTO checkpoint_diff_blobs (
          thread_id,
          from_turn_count,
          to_turn_count,
          diff,
          created_at
        )
        VALUES (${purgedThreadId}, 1, 2, 'diff', ${now})
      `;
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id,
          aggregate_kind,
          aggregate_id,
          accepted_at,
          result_sequence,
          status,
          error
        )
        VALUES
          ('command-purge', 'thread', ${purgedThreadId}, ${now}, 1, 'accepted', NULL),
          ('command-keep', 'thread', ${keptThreadId}, ${now}, 2, 'accepted', NULL)
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
          ('event-purge', 'thread', ${purgedThreadId}, 1, 'thread.created', ${now}, 'system', '{}', '{}'),
          ('event-keep', 'thread', ${keptThreadId}, 1, 'thread.created', ${now}, 'system', '{}', '{}')
      `;

      yield* purgeThreadDatabaseRows(purgedThreadId);

      const purgedRows = yield* sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM projection_threads WHERE thread_id = ${purgedThreadId}) +
          (SELECT COUNT(*) FROM projection_thread_messages WHERE thread_id = ${purgedThreadId}) +
          (SELECT COUNT(*) FROM projection_thread_activities WHERE thread_id = ${purgedThreadId}) +
          (SELECT COUNT(*) FROM projection_thread_sessions WHERE thread_id = ${purgedThreadId}) +
          (SELECT COUNT(*) FROM projection_turns WHERE thread_id = ${purgedThreadId}) +
          (SELECT COUNT(*) FROM projection_thread_proposed_plans WHERE thread_id = ${purgedThreadId}) +
          (SELECT COUNT(*) FROM projection_pending_approvals WHERE thread_id = ${purgedThreadId}) +
          (SELECT COUNT(*) FROM provider_session_runtime WHERE thread_id = ${purgedThreadId}) +
          (SELECT COUNT(*) FROM checkpoint_diff_blobs WHERE thread_id = ${purgedThreadId}) +
          (SELECT COUNT(*) FROM orchestration_command_receipts WHERE aggregate_id = ${purgedThreadId}) +
          (SELECT COUNT(*) FROM orchestration_events WHERE stream_id = ${purgedThreadId}) AS count
      `;
      const keptRows = yield* sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM projection_threads WHERE thread_id = ${keptThreadId}) +
          (SELECT COUNT(*) FROM projection_thread_messages WHERE thread_id = ${keptThreadId}) +
          (SELECT COUNT(*) FROM orchestration_command_receipts WHERE aggregate_id = ${keptThreadId}) +
          (SELECT COUNT(*) FROM orchestration_events WHERE stream_id = ${keptThreadId}) AS count
      `;

      expect(purgedRows[0]?.count).toBe(0);
      expect(keptRows[0]?.count).toBe(4);
    }),
  );
});
