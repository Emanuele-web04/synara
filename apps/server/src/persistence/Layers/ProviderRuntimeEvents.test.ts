import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PROVIDER_RUNTIME_EVENT_MAX_BYTES,
  PROVIDER_RUNTIME_INGESTION_CONSUMER,
  ProviderRuntimeEventRepository,
} from "../Services/ProviderRuntimeEvents.ts";
import { ProviderRuntimeEventRepositoryLive } from "./ProviderRuntimeEvents.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { assignDerivedProviderRuntimeEventIds } from "../../provider/providerRuntimeEventIdentity.ts";

const layer = it.layer(
  ProviderRuntimeEventRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const runtimeEvent = (eventId: string, delta: string): ProviderRuntimeEvent => ({
  type: "content.delta",
  eventId: EventId.makeUnsafe(eventId),
  provider: "codex",
  createdAt: "2026-07-14T00:00:00.000Z",
  threadId: ThreadId.makeUnsafe("thread-runtime-journal"),
  turnId: TurnId.makeUnsafe("turn-runtime-journal"),
  payload: {
    streamKind: "assistant_text",
    delta,
  },
});

layer("ProviderRuntimeEventRepository", (it) => {
  it.effect("journals exact events and advances its consumer cursor contiguously", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderRuntimeEventRepository;
      const first = yield* repository.append(runtimeEvent("runtime-event-1", "hello"));
      const duplicate = yield* repository.append(runtimeEvent("runtime-event-1", "hello"));
      const second = yield* repository.append(runtimeEvent("runtime-event-2", " world"));

      assert.strictEqual(duplicate.sequence, first.sequence);
      assert.isAbove(second.sequence, first.sequence);
      assert.strictEqual(yield* repository.getHighWaterSequence, second.sequence);

      const rows = yield* repository.readAfter({
        sequenceExclusive: 0,
        throughSequenceInclusive: second.sequence,
        limit: 10,
      });
      assert.deepStrictEqual(
        rows.map((row) => [row.sequence, row.event.eventId]),
        [
          [first.sequence, "runtime-event-1"],
          [second.sequence, "runtime-event-2"],
        ],
      );
      assert.deepStrictEqual(yield* repository.getThreadCoverage("thread-runtime-journal"), {
        retainedCount: 2,
        oldestSequence: first.sequence,
        highWaterSequence: second.sequence,
      });
      assert.deepStrictEqual(
        (yield* repository.readThreadEvents({
          threadId: "thread-runtime-journal",
          throughSequenceInclusive: second.sequence,
          beforeSequenceExclusive: second.sequence,
          turnId: "turn-runtime-journal",
          eventTypes: ["content.delta"],
          limit: 10,
        })).map((row) => row.event.eventId),
        ["runtime-event-1"],
      );

      const skipped = yield* repository.advanceConsumerCursor({
        consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
        eventSequence: second.sequence,
        updatedAt: "2026-07-14T00:00:01.000Z",
      });
      assert.isFalse(skipped);
      const advanced = yield* repository.advanceConsumerCursor({
        consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
        eventSequence: first.sequence,
        updatedAt: "2026-07-14T00:00:01.000Z",
      });
      assert.isTrue(advanced);
      assert.strictEqual(
        yield* repository.getConsumerCursor(PROVIDER_RUNTIME_INGESTION_CONSUMER),
        first.sequence,
      );
      assert.deepStrictEqual(
        (yield* repository.readAcceptedOpenTurnEvents({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          sequenceExclusive: 0,
          limit: 10,
        })).map((row) => row.event.eventId),
        ["runtime-event-1"],
      );

      assert.isTrue(
        yield* repository.advanceConsumerCursor({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          eventSequence: second.sequence,
          updatedAt: "2026-07-14T00:00:02.000Z",
        }),
      );
      const terminal = yield* repository.append({
        type: "turn.completed",
        eventId: EventId.makeUnsafe("runtime-event-terminal"),
        provider: "codex",
        createdAt: "2026-07-14T00:00:03.000Z",
        threadId: ThreadId.makeUnsafe("thread-runtime-journal"),
        turnId: TurnId.makeUnsafe("turn-runtime-journal"),
        payload: { state: "completed" },
      });
      assert.isTrue(
        yield* repository.advanceConsumerCursor({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          eventSequence: terminal.sequence,
          updatedAt: "2026-07-14T00:00:03.000Z",
        }),
      );
      assert.lengthOf(
        yield* repository.readAcceptedOpenTurnEvents({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          sequenceExclusive: 0,
          limit: 10,
        }),
        0,
      );

      const conflict = yield* Effect.flip(
        repository.append(runtimeEvent("runtime-event-1", "different")),
      );
      assert.strictEqual(conflict._tag, "PersistenceDecodeError");
    }),
  );

  it.effect("prunes replay rows after their projected turn settles", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderRuntimeEventRepository;
      const sql = yield* SqlClient.SqlClient;
      const event = runtimeEvent("runtime-event-settled-turn", "stale replay");
      const persisted = yield* repository.append(event);

      assert.isTrue(
        yield* repository.advanceConsumerCursor({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          eventSequence: persisted.sequence,
          updatedAt: "2026-07-14T00:01:00.000Z",
        }),
      );
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, checkpoint_files_json
        ) VALUES (
          ${event.threadId}, ${event.turnId}, 'running',
          ${event.createdAt}, '[]'
        )
      `;

      yield* repository.pruneSettledOpenTurns;
      assert.lengthOf(
        yield* repository.readAcceptedOpenTurnEvents({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          sequenceExclusive: 0,
          limit: 10,
        }),
        1,
      );

      yield* sql`
        UPDATE projection_turns
        SET state = 'interrupted', completed_at = ${"2026-07-14T00:01:01.000Z"}
        WHERE thread_id = ${event.threadId} AND turn_id = ${event.turnId}
      `;
      yield* repository.pruneSettledOpenTurns;

      assert.lengthOf(
        yield* repository.readAcceptedOpenTurnEvents({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          sequenceExclusive: 0,
          limit: 10,
        }),
        0,
      );
    }),
  );

  it.effect("compacts oversized raw provider payloads without losing the canonical event", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderRuntimeEventRepository;
      const oversized = {
        ...runtimeEvent("runtime-event-oversized-raw", "terminal-safe"),
        raw: {
          source: "codex.eventmsg" as const,
          method: "codex/event/task_complete",
          payload: {
            transcript: "x".repeat(PROVIDER_RUNTIME_EVENT_MAX_BYTES),
          },
        },
      } satisfies ProviderRuntimeEvent;

      const persisted = yield* repository.append(oversized);
      const rows = yield* repository.readAfter({
        sequenceExclusive: persisted.sequence - 1,
        throughSequenceInclusive: persisted.sequence,
        limit: 1,
      });

      assert.strictEqual(persisted.event.eventId, oversized.eventId);
      assert.deepStrictEqual(persisted.event.payload, oversized.payload);
      const compactedRaw = rows[0]?.event.raw?.payload as
        | {
            readonly synaraTruncated?: unknown;
            readonly reason?: unknown;
            readonly originalBytes?: unknown;
          }
        | undefined;
      assert.deepInclude(compactedRaw, {
        synaraTruncated: true,
        reason: "provider runtime event exceeded the durable journal size limit",
      });
      assert.isNumber(compactedRaw?.originalBytes);
    }),
  );

  it.effect("journals every canonical event derived from one provider notification", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderRuntimeEventRepository;
      const common = {
        eventId: EventId.makeUnsafe("native-task-complete"),
        provider: "codex" as const,
        createdAt: "2026-07-14T00:02:00.000Z",
        threadId: ThreadId.makeUnsafe("thread-derived-runtime-journal"),
        turnId: TurnId.makeUnsafe("turn-derived-runtime-journal"),
      };
      const derived = assignDerivedProviderRuntimeEventIds([
        {
          ...common,
          type: "task.completed",
          payload: { taskId: "task-1", status: "completed" },
        },
        {
          ...common,
          type: "turn.proposed.completed",
          payload: { planMarkdown: "# Plan" },
        },
      ]);

      const persisted = yield* Effect.forEach(derived, repository.append, {
        concurrency: 1,
      });
      assert.deepStrictEqual(
        persisted.map(({ event }) => event.eventId),
        ["native-task-complete:task.completed:0", "native-task-complete:turn.proposed.completed:1"],
      );
      assert.notStrictEqual(persisted[0]?.sequence, persisted[1]?.sequence);
    }),
  );
});
