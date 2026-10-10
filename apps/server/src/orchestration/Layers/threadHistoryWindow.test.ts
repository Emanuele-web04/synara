import { EventId, MessageId, ThreadId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationProjectionSnapshotQueryLive,
  REQUIRED_SNAPSHOT_PROJECTORS,
} from "./ProjectionSnapshotQuery.ts";

const layer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSettingsService.layerTest()),
  ),
);
layer("thread message history windows", (it) => {
  it.effect(
    "loads a turn-complete tail and pages older messages without changing full export",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const query = yield* ProjectionSnapshotQuery;
        const threadId = ThreadId.makeUnsafe("window-thread");
        const now = "2026-10-10T10:00:00.000Z";
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('window-project','History','/tmp/history','[]',${now},${now})`;
        yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,created_at,updated_at) VALUES (${threadId},'window-project','History','{"provider":"codex","model":"gpt-5"}',${now},${now})`;
        for (let index = 0; index < 205; index++) {
          yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,turn_id,role,text,is_streaming,source,sequence,created_at,updated_at) VALUES (${`m-${index}`},${threadId},${`turn-${Math.floor(index / 10)}`},${index % 10 === 0 ? "user" : "assistant"},${`text-${index}`},0,'native',${index + 1},${now},${now})`;
        }
        for (let index = 0; index < 205; index++) {
          const time = new Date(Date.parse(now) + index * 1000).toISOString();
          yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,sequence,created_at)
        VALUES (${`a-${index}`},${threadId},NULL,'tool','tool.completed','Completed work','{}',${index + 1},${time})`;
        }
        yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,sequence,created_at)
      VALUES ('owned-start',${threadId},NULL,'info','task.started','Background work','{"taskId":"old-owned","taskType":"subagent"}',1,${now}),
             ('owned-update',${threadId},NULL,'info','task.updated','In background','{"taskId":"old-owned","isBackgrounded":true}',2,${now}),
             ('old-approval',${threadId},NULL,'approval','approval.requested','Approval','{"requestId":"pending-old","requestKind":"command"}',3,${now})`;
        const snapshot = Option.getOrThrow(
          yield* query.getThreadDetailSnapshotById(threadId, { limit: 100 }),
        );
        assert.equal(snapshot.thread.messages.length, 105);
        assert.equal(snapshot.thread.messages[0]?.id, MessageId.makeUnsafe("m-100"));
        assert.equal(snapshot.history?.totalMessageCount, 205);
        assert.equal(snapshot.history?.totalActivityCount, 208);
        assert.equal(snapshot.thread.activities.length, 103);
        assert(
          snapshot.thread.activities.some(
            (activity) => activity.id === EventId.makeUnsafe("owned-start"),
          ),
        );
        assert(
          snapshot.thread.activities.some(
            (activity) => activity.id === EventId.makeUnsafe("owned-update"),
          ),
        );
        assert(
          snapshot.thread.activities.some(
            (activity) => activity.id === EventId.makeUnsafe("old-approval"),
          ),
        );
        assert.equal(snapshot.history?.olderCursor?.messageId, MessageId.makeUnsafe("m-100"));
        const page = Option.getOrThrow(
          yield* query.getThreadDetailSnapshotById(threadId, {
            limit: 100,
            before: snapshot.history!.olderCursor!,
            beforeActivity: snapshot.history!.olderActivityCursor!,
          }),
        );
        assert.equal(page.thread.messages.length, 100);
        assert.equal(page.thread.messages[0]?.id, MessageId.makeUnsafe("m-0"));
        assert.equal(page.thread.messages.at(-1)?.id, MessageId.makeUnsafe("m-99"));
        assert.equal(page.history?.olderCursor, null);
        const oldest = Option.getOrThrow(
          yield* query.getThreadDetailSnapshotById(threadId, {
            limit: 100,
            beforeActivity: page.history!.olderActivityCursor!,
          }),
        );
        assert.equal(oldest.history?.olderActivityCursor, null);
        const allActivities = new Set(
          [
            ...snapshot.thread.activities,
            ...page.thread.activities,
            ...oldest.thread.activities,
          ].map((activity) => activity.id),
        );
        assert.equal(allActivities.size, 208);
        assert.equal(
          Option.getOrThrow(yield* query.getThreadDetailForExportById(threadId)).messages.length,
          205,
        );
        assert.equal(
          Option.getOrThrow(yield* query.getThreadDetailSnapshotById(threadId)).thread.messages
            .length,
          205,
        );
        yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'm-100'`;
        const deletedAnchorPage = Option.getOrThrow(
          yield* query.getThreadDetailSnapshotById(threadId, {
            limit: 100,
            before: snapshot.history!.olderCursor!,
          }),
        );
        assert.equal(deletedAnchorPage.thread.messages.length, 100);
        assert.equal(deletedAnchorPage.history?.olderCursor, null);
        for (const projector of REQUIRED_SNAPSHOT_PROJECTORS)
          yield* sql`INSERT INTO projection_state (projector,last_applied_sequence,updated_at) VALUES (${projector},20,${now})`;
        yield* sql`INSERT INTO orchestration_events (sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json) VALUES (21,'revision-event','thread',${threadId},1,'thread.conversation-rolled-back',${now},'user','{}','{}')`;
        assert.equal(
          Option.getOrThrow(yield* query.getThreadDetailSnapshotById(threadId, { limit: 100 }))
            .history?.revisionSequence,
          0,
        );
        yield* sql`UPDATE projection_state SET last_applied_sequence = 21`;
        assert.equal(
          Option.getOrThrow(yield* query.getThreadDetailSnapshotById(threadId, { limit: 100 }))
            .history?.revisionSequence,
          21,
        );
      }),
  );
  it.effect("pages a tool-only thread and retains an active turn larger than the legacy cap", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      const threadId = ThreadId.makeUnsafe("tool-only-thread");
      const now = "2026-10-10T10:00:00.000Z";
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('tool-only-project','History','/tmp/tools','[]',${now},${now})`;
      yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,created_at,updated_at) VALUES (${threadId},'tool-only-project','History','{"provider":"codex","model":"gpt-5"}',${now},${now})`;
      for (let index = 0; index < 205; index++) {
        const time = new Date(Date.parse(now) + index * 1000).toISOString();
        yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,sequence,created_at) VALUES (${`tool-${index}`},${threadId},NULL,'tool','tool.completed','Work','{}',${index + 1},${time})`;
      }
      const tail = Option.getOrThrow(
        yield* query.getThreadDetailSnapshotById(threadId, { limit: 100 }),
      );
      assert.equal(tail.thread.messages.length, 0);
      assert.equal(tail.thread.activities.length, 100);
      assert.equal(tail.history?.olderCursor, null);
      assert(tail.history?.olderActivityCursor);
      const page = Option.getOrThrow(
        yield* query.getThreadDetailSnapshotById(threadId, {
          limit: 100,
          beforeActivity: tail.history!.olderActivityCursor!,
        }),
      );
      assert.equal(page.thread.activities.length, 100);
      const first = Option.getOrThrow(
        yield* query.getThreadDetailSnapshotById(threadId, {
          limit: 100,
          beforeActivity: page.history!.olderActivityCursor!,
        }),
      );
      assert.equal(first.thread.activities.length, 5);
      assert.equal(first.history?.olderActivityCursor, null);
      // The active request can predate thousands of queued assistant rows.
      yield* sql`UPDATE projection_threads SET latest_turn_id = 'big-active' WHERE thread_id = ${threadId}`;
      const messages = Array.from({ length: 2105 }, (_, index) => ({
        message_id: `big-${index}`,
        thread_id: threadId,
        turn_id: "big-active",
        role: index === 0 ? "user" : "assistant",
        text: "text",
        is_streaming: 0,
        source: "native",
        sequence: index + 1,
        created_at: now,
        updated_at: now,
      }));
      yield* sql`INSERT INTO projection_thread_messages ${sql.insert(messages)}`;
      assert.equal(
        Option.getOrThrow(yield* query.getThreadDetailSnapshotById(threadId, { limit: 100 })).thread
          .messages.length,
        2105,
      );
      assert.equal(
        Option.getOrThrow(yield* query.getThreadDetailSnapshotById(threadId)).thread.messages
          .length,
        2000,
      );
      assert.equal(
        Option.getOrThrow(yield* query.getThreadDetailForExportById(threadId)).messages.length,
        2105,
      );
    }),
  );
});
