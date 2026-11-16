import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  QUEUED_TURN_PROMOTION_TRANSITIONS,
  QueuedTurnPromotionRepository,
  TERMINAL_QUEUED_TURN_PROMOTION_STATES,
  canTransitionQueuedTurnPromotion,
  type QueuedTurnPromotionState,
} from "../Services/QueuedTurnPromotions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { QueuedTurnPromotionRepositoryLive } from "./QueuedTurnPromotions.ts";

const layer = it.layer(
  QueuedTurnPromotionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("QueuedTurnPromotionRepository", (it) => {
  it.effect(
    "preserves priority, reclaims foreign owners, and permits a later message generation",
    () =>
      Effect.gen(function* () {
        const repository = yield* QueuedTurnPromotionRepository;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-07-14T00:00:00.000Z";
        const insertSourceEvent = (id: number) =>
          sql<{ readonly sequence: number }>`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, command_id, causation_event_id, correlation_id,
            actor_kind, payload_json, metadata_json
          ) VALUES (
            ${`evt-queued-promotion-${id}`}, 'thread', 'thread-queued-promotion', ${id - 1},
            'thread.turn-queued', ${now}, ${`cmd-queued-promotion-${id}`},
            NULL, NULL, 'server', '{}', '{}'
          )
          RETURNING sequence
        `.pipe(Effect.map((rows) => rows[0]!.sequence));

        const queuedSequence = yield* insertSourceEvent(1);
        const steerSequence = yield* insertSourceEvent(2);
        yield* repository.enqueue({
          queuedEventSequence: queuedSequence,
          threadId: "thread-queued-promotion",
          messageId: "message-queue",
          dispatchMode: "queue",
          createdAt: now,
        });
        yield* repository.enqueue({
          queuedEventSequence: steerSequence,
          threadId: "thread-queued-promotion",
          messageId: "message-steer",
          dispatchMode: "steer",
          createdAt: now,
        });

        const firstClaim = yield* repository.claimNext({
          threadId: "thread-queued-promotion",
          claimOwner: "owner-before-crash",
          claimedAt: now,
          claimExpiresAt: "2099-01-01T00:00:00.000Z",
        });
        assert.strictEqual(firstClaim.pipe(Option.getOrThrow).queuedEventSequence, steerSequence);

        const reclaimed = yield* repository.claimNext({
          threadId: "thread-queued-promotion",
          claimOwner: "owner-after-restart",
          claimedAt: now,
          claimExpiresAt: "2099-01-01T00:00:00.000Z",
        });
        assert.deepInclude(reclaimed.pipe(Option.getOrThrow), {
          queuedEventSequence: steerSequence,
          attemptCount: 2,
        });
        assert.isTrue(
          yield* repository.markPromoted({
            queuedEventSequence: steerSequence,
            claimOwner: "owner-after-restart",
            promotedAt: now,
          }),
        );

        const nextClaim = yield* repository.claimNext({
          threadId: "thread-queued-promotion",
          claimOwner: "owner-after-restart",
          claimedAt: now,
          claimExpiresAt: "2099-01-01T00:00:00.000Z",
        });
        assert.strictEqual(nextClaim.pipe(Option.getOrThrow).queuedEventSequence, queuedSequence);
        yield* repository.releaseClaim({
          queuedEventSequence: queuedSequence,
          claimOwner: "owner-after-restart",
          updatedAt: now,
        });

        const laterSteerSequence = yield* insertSourceEvent(3);
        yield* repository.enqueue({
          queuedEventSequence: laterSteerSequence,
          threadId: "thread-queued-promotion",
          messageId: "message-steer",
          dispatchMode: "steer",
          createdAt: now,
        });
        const laterGeneration = yield* repository.claimNext({
          threadId: "thread-queued-promotion",
          claimOwner: "owner-later-generation",
          claimedAt: now,
          claimExpiresAt: "2099-01-01T00:00:00.000Z",
        });
        assert.strictEqual(
          laterGeneration.pipe(Option.getOrThrow).queuedEventSequence,
          laterSteerSequence,
        );

        // `laterSteerSequence` is currently claimed ('promoting'). cancelThread now
        // widens to cancel BOTH 'queued' and 'promoting' rows, so the in-flight
        // claim is cancelled immediately -> nothing pending.
        yield* repository.cancelThread({
          threadId: "thread-queued-promotion",
          updatedAt: now,
        });
        assert.isFalse(
          yield* repository.hasPendingMessage({
            threadId: "thread-queued-promotion",
            messageId: "message-steer",
          }),
        );

        // The drain's error path releasing the (now cancelled) claim must NOT
        // resurrect it: releaseClaim only matches state='promoting', which the
        // cancelled row no longer is, so it reports no-op and the row stays dead.
        const released = yield* repository.releaseClaim({
          queuedEventSequence: laterSteerSequence,
          claimOwner: "owner-later-generation",
          updatedAt: now,
        });
        assert.isFalse(released);
        assert.isFalse(
          yield* repository.hasPendingMessage({
            threadId: "thread-queued-promotion",
            messageId: "message-steer",
          }),
        );
      }),
  );

  // The SQL guards are the authoritative enforcement of the promotion state machine.
  // Drive every helper from every state so a guard that drifts from the declared table
  // fails here instead of resurrecting a cancelled turn or double-promoting a message.
  it.effect("moves a promotion only along the declared lifecycle transitions", () =>
    Effect.gen(function* () {
      const repository = yield* QueuedTurnPromotionRepository;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-07-14T00:00:00.000Z";
      const future = "2099-01-01T00:00:00.000Z";
      const owner = "owner-lifecycle";
      const insertSourceEvent = (streamId: string, version: number) =>
        sql<{ readonly sequence: number }>`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, command_id, causation_event_id, correlation_id,
            actor_kind, payload_json, metadata_json
          ) VALUES (
            ${`evt-${streamId}-${version}`}, 'thread', ${streamId}, ${version},
            'thread.turn-queued', ${now}, ${`cmd-${streamId}-${version}`},
            NULL, NULL, 'server', '{}', '{}'
          )
          RETURNING sequence
        `.pipe(Effect.map((rows) => rows[0]!.sequence));

      // Each helper moves a row to `to`, but only from the states listed in `from`.
      const helpers = {
        claimNext: {
          to: "promoting",
          from: ["queued"],
          run: (threadId: string) =>
            repository
              .claimNext({ threadId, claimOwner: owner, claimedAt: now, claimExpiresAt: future })
              .pipe(Effect.asVoid),
        },
        releaseClaim: {
          to: "queued",
          from: ["promoting"],
          run: (_threadId: string, queuedEventSequence: number) =>
            repository
              .releaseClaim({ queuedEventSequence, claimOwner: owner, updatedAt: now })
              .pipe(Effect.asVoid),
        },
        markPromoted: {
          to: "promoted",
          from: ["promoting"],
          run: (_threadId: string, queuedEventSequence: number) =>
            repository
              .markPromoted({ queuedEventSequence, claimOwner: owner, promotedAt: now })
              .pipe(Effect.asVoid),
        },
        cancelMessage: {
          to: "cancelled",
          from: ["queued"],
          run: (threadId: string) =>
            repository
              .cancelMessage({ threadId, messageId: "message-lifecycle", updatedAt: now })
              .pipe(Effect.asVoid),
        },
        cancelThread: {
          to: "cancelled",
          from: ["queued", "promoting"],
          run: (threadId: string) => repository.cancelThread({ threadId, updatedAt: now }),
        },
      } satisfies Record<
        string,
        {
          readonly to: QueuedTurnPromotionState;
          readonly from: ReadonlyArray<QueuedTurnPromotionState>;
          readonly run: (
            threadId: string,
            queuedEventSequence: number,
          ) => Effect.Effect<void, unknown>;
        }
      >;

      const states = Object.keys(QUEUED_TURN_PROMOTION_TRANSITIONS) as QueuedTurnPromotionState[];
      const seed = (threadId: string, state: QueuedTurnPromotionState) =>
        Effect.gen(function* () {
          const sequence = yield* insertSourceEvent(threadId, 0);
          yield* repository.enqueue({
            queuedEventSequence: sequence,
            threadId,
            messageId: "message-lifecycle",
            dispatchMode: "queue",
            createdAt: now,
          });
          // Only a claimed row carries an owner; every write that leaves 'promoting' clears it.
          yield* sql`
            UPDATE queued_turn_promotions
            SET state = ${state},
                claim_owner = ${state === "promoting" ? owner : null},
                claimed_at = ${state === "promoting" ? now : null},
                claim_expires_at = ${state === "promoting" ? future : null}
            WHERE queued_event_sequence = ${sequence}
          `;
          return sequence;
        });
      const stateOf = (sequence: number) =>
        repository
          .getBySequence(sequence)
          .pipe(Effect.map((row) => row.pipe(Option.getOrThrow).state));

      for (const [name, helper] of Object.entries(helpers)) {
        for (const from of states) {
          const threadId = `thread-lifecycle-${name}-${from}`;
          const sequence = yield* seed(threadId, from);

          yield* helper.run(threadId, sequence);

          const acts = (helper.from as ReadonlyArray<QueuedTurnPromotionState>).includes(from);
          assert.strictEqual(yield* stateOf(sequence), acts ? helper.to : from, `${name}: ${from}`);
          if (acts) {
            assert.isTrue(canTransitionQueuedTurnPromotion(from, helper.to), `${name}: ${from}`);
          }
        }
      }

      // Every declared edge is realized by some repository helper.
      for (const from of states) {
        for (const to of QUEUED_TURN_PROMOTION_TRANSITIONS[from]) {
          assert.isTrue(
            Object.values(helpers).some(
              (helper) =>
                helper.to === to &&
                (helper.from as ReadonlyArray<QueuedTurnPromotionState>).includes(from),
            ),
            `${from} -> ${to}`,
          );
        }
      }

      // Re-enqueueing a message never revives its row: a terminal row stays put and the
      // newer sequence becomes a new pending row; a pending row keeps the message's slot.
      for (const from of states) {
        const threadId = `thread-lifecycle-reenqueue-${from}`;
        const sequence = yield* seed(threadId, from);
        const laterSequence = yield* insertSourceEvent(threadId, 1);
        yield* repository.enqueue({
          queuedEventSequence: laterSequence,
          threadId,
          messageId: "message-lifecycle",
          dispatchMode: "queue",
          createdAt: now,
        });
        assert.strictEqual(yield* stateOf(sequence), from, `re-enqueue: ${from}`);
        const terminal = (
          TERMINAL_QUEUED_TURN_PROMOTION_STATES as ReadonlyArray<QueuedTurnPromotionState>
        ).includes(from);
        const later = yield* repository.getBySequence(laterSequence);
        assert.strictEqual(
          Option.isSome(later) ? later.value.state : null,
          terminal ? "queued" : null,
          `re-enqueue: ${from}`,
        );
      }
    }),
  );
});
