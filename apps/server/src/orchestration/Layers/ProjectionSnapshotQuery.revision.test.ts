import { ThreadId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationProjectionSnapshotQueryLive,
  REQUIRED_SNAPSHOT_PROJECTORS,
} from "./ProjectionSnapshotQuery.ts";

const now = "2026-11-13T10:00:00.000Z";

const seedJournal = (threadId: ThreadId, seed: number, count: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    let random = seed;
    const next = () => {
      random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
      return random;
    };
    const events = Array.from({ length: count }, (_, index) => {
      const sequence = index + 1;
      return {
        sequence,
        aggregateKind: next() % 13 === 0 ? "project" : "thread",
        streamId: next() % 7 === 0 ? "other-thread" : threadId,
        type:
          index % 37 === 0
            ? "thread.reverted"
            : index % 41 === 0
              ? "thread.conversation-rolled-back"
              : "thread.message-sent",
      };
    });
    events.splice(
      0,
      6,
      { sequence: 1, aggregateKind: "thread", streamId: threadId, type: "thread.reverted" },
      { sequence: 2, aggregateKind: "project", streamId: threadId, type: "thread.reverted" },
      {
        sequence: 3,
        aggregateKind: "thread",
        streamId: threadId,
        type: "thread.conversation-rolled-back",
      },
      { sequence: 4, aggregateKind: "thread", streamId: "other-thread", type: "thread.reverted" },
      { sequence: 5, aggregateKind: "thread", streamId: threadId, type: "thread.message-sent" },
      { sequence: 6, aggregateKind: "thread", streamId: threadId, type: "thread.reverted" },
    );
    yield* sql`DELETE FROM orchestration_events`;
    yield* sql`DELETE FROM projection_state`;
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${threadId}, 'Revision test', '/tmp/revision-test', '[]', ${now}, ${now})`;
    yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, created_at, updated_at)
      VALUES (${threadId}, ${threadId}, 'Revision test', '{"provider":"codex","model":"gpt-5"}', ${now}, ${now})`;
    yield* sql`INSERT INTO orchestration_events
      (sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
       occurred_at, actor_kind, payload_json, metadata_json)
      SELECT json_extract(value, '$.sequence'), 'revision-event-' || json_extract(value, '$.sequence'),
        json_extract(value, '$.aggregateKind'), json_extract(value, '$.streamId'),
        json_extract(value, '$.sequence'), json_extract(value, '$.type'),
        ${now}, 'user', '{}', '{}'
      FROM json_each(${JSON.stringify(events)})`;
    return events;
  });

const setProjectionFence = (fence: number, head: number, laggingProjector: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM projection_state`;
    for (const [index, projector] of REQUIRED_SNAPSHOT_PROJECTORS.entries()) {
      yield* sql`INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES (${projector}, ${index === laggingProjector ? fence : head}, ${now})`;
    }
    yield* sql`INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
      VALUES ('unrelated-background-projector', 0, ${now})`;
  });

const legacyRevision = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<{ historyRevisionSequence: number }>`
    SELECT COALESCE(MAX(sequence), 0) AS "historyRevisionSequence"
    FROM orchestration_events
    WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
      AND event_type IN ('thread.reverted', 'thread.conversation-rolled-back')
      AND sequence <= COALESCE((
        SELECT MIN(last_applied_sequence) FROM projection_state
        WHERE ${sql.in("projector", REQUIRED_SNAPSHOT_PROJECTORS)}
      ), 0)
  `;

it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSettingsService.layerTest()),
  ),
)("ProjectionSnapshotQuery history revision", (it) => {
  it.effect("matches legacy revision reads across generated journals and projector fences", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      for (const seed of [19, 41, 73]) {
        const threadId = ThreadId.makeUnsafe(`generated-revision-${seed}`);
        const events = yield* seedJournal(threadId, seed, 2053);
        for (const [index, fence] of [0, 1, 2, 3, 4, 5, 6, 37, 1024, 2052, 2053].entries()) {
          yield* setProjectionFence(
            fence,
            events.length,
            index % REQUIRED_SNAPSHOT_PROJECTORS.length,
          );
          const expected = yield* legacyRevision(sql, threadId);
          let checked = 0;
          const compareRevision: Statement.Transformer = (statement) =>
            Effect.gen(function* () {
              const [text, parameters] = statement.compile();
              if (!text.includes('AS "historyRevisionSequence"')) return statement;
              const actual = yield* sql
                .unsafe(text, parameters)
                .pipe(Effect.provideService(Statement.CurrentTransformer, undefined), Effect.orDie);
              assert.equal(JSON.stringify(actual), JSON.stringify(expected));
              checked += 1;
              return statement;
            });
          const snapshot = Option.getOrThrow(
            yield* query
              .getThreadDetailSnapshotById(threadId)
              .pipe(Effect.provideService(Statement.CurrentTransformer, compareRevision)),
          );
          const expectedSequence = Math.max(
            0,
            ...events
              .filter(
                (event) =>
                  event.aggregateKind === "thread" &&
                  event.streamId === threadId &&
                  (event.type === "thread.reverted" ||
                    event.type === "thread.conversation-rolled-back") &&
                  event.sequence <= fence,
              )
              .map((event) => event.sequence),
          );
          assert.equal(checked, 1);
          assert.equal(snapshot.snapshotSequence, fence);
          assert.equal(snapshot.historyRevisionSequence, expectedSequence);
        }
        yield* sql`DELETE FROM projection_state`;
        const unprojected = Option.getOrThrow(yield* query.getThreadDetailSnapshotById(threadId));
        assert.equal(unprojected.snapshotSequence, 0);
        assert.equal(unprojected.historyRevisionSequence, 0);
        yield* setProjectionFence(events.length, events.length, 0);
        yield* sql`DELETE FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
            AND event_type IN ('thread.reverted', 'thread.conversation-rolled-back')`;
        assert.equal(
          Option.getOrThrow(yield* query.getThreadDetailSnapshotById(threadId))
            .historyRevisionSequence,
          0,
        );
      }
    }),
  );

  it.effect("finds history revisions without scanning unrelated thread events", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("bounded-history-revision");
      const events = yield* seedJournal(threadId, 101, 4096);
      yield* setProjectionFence(events.length, events.length, 0);
      let checked = 0;
      const verifySelectiveLookup: Statement.Transformer = (statement) =>
        Effect.gen(function* () {
          const [text, parameters] = statement.compile();
          if (!text.includes('AS "historyRevisionSequence"')) return statement;
          const plan = yield* sql
            .unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${text}`, parameters)
            .pipe(Effect.provideService(Statement.CurrentTransformer, undefined), Effect.orDie);
          assert.isTrue(plan.some((row) => row.detail.includes("event_type=?")));
          assert.deepEqual(
            plan.filter(
              (row) =>
                /\bSCAN orchestration_events\b/.test(row.detail) ||
                /\bUSING (COVERING )?INDEX idx_orch_events_stream_(sequence|version)\b/.test(
                  row.detail,
                ),
            ),
            [],
          );
          checked += 1;
          return statement;
        });
      yield* query
        .getThreadDetailSnapshotById(threadId)
        .pipe(Effect.provideService(Statement.CurrentTransformer, verifySelectiveLookup));
      assert.equal(checked, 1);
    }),
  );
});
