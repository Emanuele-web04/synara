import { ThreadId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { selectMessageTextChunks } from "../../persistence/messageTextChunks.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const now = "2026-11-13T10:00:00.000Z";

const legacyMessageRows = (sql: SqlClient.SqlClient, threadId: ThreadId, limit: number | null) =>
  sql<{ messageId: string }>`
    SELECT
      message_id AS "messageId", thread_id AS "threadId", turn_id AS "turnId",
      role, text, text_json AS "encodedText",
      ${selectMessageTextChunks(sql, "projection_thread_messages")},
      attachments_json AS "attachments", skills_json AS "skills", mentions_json AS "mentions",
      dispatch_mode AS "dispatchMode", dispatch_origin AS "dispatchOrigin",
      starts_new_turn AS "startsNewTurn", async_user_input_json AS "asyncUserInput",
      is_streaming AS "isStreaming", source, sequence,
      created_at AS "createdAt", updated_at AS "updatedAt"
    FROM (
      SELECT thread_id, message_id,
        ROW_NUMBER() OVER (
          PARTITION BY thread_id
          ORDER BY CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
            sequence DESC, created_at DESC, message_id DESC
        ) AS message_rank
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
    ) AS ranks
    JOIN projection_thread_messages USING (thread_id, message_id)
    WHERE thread_id = ${threadId} AND (${limit} IS NULL OR message_rank <= ${limit})
    ORDER BY CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
      sequence ASC, created_at ASC, message_id ASC
  `;

const seedThread = (
  threadId: ThreadId,
  count: number,
  seed: number,
  ordering: "mixed" | "null" | "unique",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    let random = seed;
    const next = () => {
      random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
      return random;
    };
    const rows = Array.from({ length: count }, (_, index) => ({
      id: `message-${String(count - index).padStart(5, "0")}`,
      turn: `turn-${Math.floor(index / 7)}`,
      sequence:
        ordering === "null"
          ? null
          : ordering === "unique"
            ? index
            : index % 5 === 0
              ? null
              : next() % 31,
      createdAt: new Date(Date.parse(now) + (next() % 4) * 1000).toISOString(),
      text: `${threadId}:${index}:\ntext`,
      encodedText: index % 11 === 0 ? JSON.stringify(`encoded:${threadId}:${index}\u0000`) : null,
      role: index % 2 === 0 ? "user" : "assistant",
    }));
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${threadId}, 'Tail test', '/tmp/tail-test', '[]', ${now}, ${now})`;
    yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, created_at, updated_at)
      VALUES (${threadId}, ${threadId}, 'Tail test', '{"provider":"codex","model":"gpt-5"}', ${now}, ${now})`;
    yield* sql`INSERT INTO projection_thread_messages
      (message_id, thread_id, turn_id, role, text, text_json, sequence,
       attachments_json, skills_json, mentions_json, dispatch_mode, dispatch_origin,
       starts_new_turn, is_streaming, source, created_at, updated_at)
      SELECT json_extract(value, '$.id'), ${threadId}, json_extract(value, '$.turn'),
        json_extract(value, '$.role'), json_extract(value, '$.text'),
        json_extract(value, '$.encodedText'), json_extract(value, '$.sequence'),
        '[]', '[]', '[]', 'queue', 'user', 0, 0, 'native',
        json_extract(value, '$.createdAt'), ${now}
      FROM json_each(${JSON.stringify(rows)})`;
    for (const row of rows.slice(-3)) {
      yield* sql`INSERT INTO message_text_chunks
        (thread_id, message_id, event_sequence, text_json, updated_at)
        VALUES (${threadId}, ${row.id}, 2, ${JSON.stringify("second")}, ${now}),
               (${threadId}, ${row.id}, 1, ${JSON.stringify("first")}, ${now})`;
    }
  });

const verifyLegacyMessageRead = (threadId: ThreadId, limit: number | null) =>
  Effect.gen(function* () {
    const query = yield* ProjectionSnapshotQuery;
    const sql = yield* SqlClient.SqlClient;
    const expected = yield* legacyMessageRows(sql, threadId, limit);
    let checked = 0;
    const compareRows: Statement.Transformer = (statement) =>
      Effect.gen(function* () {
        const [text, parameters] = statement.compile();
        if (
          !text.includes('message_id AS "messageId"') ||
          !text.includes("FROM projection_thread_messages")
        ) {
          return statement;
        }
        const actual = yield* sql
          .unsafe(text, parameters)
          .pipe(Effect.provideService(Statement.CurrentTransformer, undefined), Effect.orDie);
        assert.equal(JSON.stringify(actual), JSON.stringify(expected));
        checked += 1;
        return statement;
      });
    const messages =
      limit === null
        ? Option.getOrThrow(
            yield* query
              .getThreadDetailForExportById(threadId)
              .pipe(Effect.provideService(Statement.CurrentTransformer, compareRows)),
          ).messages
        : Option.getOrThrow(
            yield* query
              .getThreadMentionContextById(threadId, { messageLimit: limit })
              .pipe(Effect.provideService(Statement.CurrentTransformer, compareRows)),
          ).messages;
    assert.equal(checked, 1);
    assert.deepEqual(
      messages.map((message) => message.id),
      expected.map((row) => row.messageId),
    );
  });

it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSettingsService.layerTest()),
  ),
)("ProjectionSnapshotQuery message tail", (it) => {
  it.effect("matches legacy message rows for generated ordering and cap combinations", () =>
    Effect.gen(function* () {
      for (const fixture of [
        { count: 0, seed: 1, ordering: "mixed" },
        { count: 37, seed: 17, ordering: "mixed" },
        { count: 2007, seed: 31, ordering: "null" },
        { count: 2047, seed: 53, ordering: "mixed" },
        { count: 2001, seed: 97, ordering: "unique" },
      ] as const) {
        const threadId = ThreadId.makeUnsafe(`generated-tail-${fixture.seed}`);
        yield* seedThread(threadId, fixture.count, fixture.seed, fixture.ordering);
        for (const limit of [-3, -0.5, 0, 0.75, 1, 1.9, 17, 2000, 2000.9, 9999, null]) {
          yield* verifyLegacyMessageRead(threadId, limit);
        }
        const query = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;
        const expected = yield* legacyMessageRows(sql, threadId, 2000);
        const detail = yield* query.getThreadDetailById(threadId);
        assert.deepEqual(
          Option.getOrThrow(detail).messages.map((message) => message.id),
          expected.map((row) => row.messageId),
        );
      }
    }),
  );

  it.effect("matches legacy tails after message deletion and turn removal", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.makeUnsafe("tail-after-removal");
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* seedThread(threadId, 2011, 109, "mixed");
      yield* sql`DELETE FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND (message_id IN ('message-00001', 'message-01000') OR turn_id = 'turn-286')`;
      yield* verifyLegacyMessageRead(threadId, 2000);
      yield* verifyLegacyMessageRead(threadId, 7);
      yield* verifyLegacyMessageRead(threadId, null);
      yield* sql`UPDATE projection_threads SET deleted_at = ${now} WHERE thread_id = ${threadId}`;
      assert.isTrue(Option.isNone(yield* query.getThreadDetailById(threadId)));
      assert.isTrue(Option.isNone(yield* query.getThreadDetailForExportById(threadId)));
      assert.isTrue(
        Option.isNone(yield* query.getThreadMentionContextById(threadId, { messageLimit: 7 })),
      );
    }),
  );

  it.effect("selects a capped message tail without ranking the full thread", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.makeUnsafe("bounded-message-tail");
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* seedThread(threadId, 2100, 127, "unique");
      let checked = 0;
      const verifyBoundedSelection: Statement.Transformer = (statement) =>
        Effect.gen(function* () {
          const [text, parameters] = statement.compile();
          if (
            !text.includes('message_id AS "messageId"') ||
            !text.includes("FROM projection_thread_messages")
          ) {
            return statement;
          }
          const operations = yield* sql
            .unsafe<{ opcode: string; p4: string | null }>(`EXPLAIN ${text}`, parameters)
            .pipe(Effect.provideService(Statement.CurrentTransformer, undefined), Effect.orDie);
          assert.deepEqual(
            operations.filter(
              (operation) =>
                operation.opcode === "AggStep" &&
                /^(row_number|rank|dense_rank)\(/.test(operation.p4 ?? ""),
            ),
            [],
          );
          checked += 1;
          return statement;
        });
      const detail = yield* query
        .getThreadDetailById(threadId)
        .pipe(Effect.provideService(Statement.CurrentTransformer, verifyBoundedSelection));
      assert.equal(checked, 1);
      assert.equal(Option.getOrThrow(detail).messages.length, 2000);
    }),
  );
});
