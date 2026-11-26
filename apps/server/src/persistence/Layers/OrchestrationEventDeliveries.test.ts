import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  BLOCKED_ORCHESTRATION_EVENT_DELIVERY_STATES,
  ORCHESTRATION_EVENT_DELIVERY_TRANSITIONS,
  OrchestrationEventDeliveryRepository,
  PROVIDER_COMMAND_REACTOR_CONSUMER,
  canTransitionOrchestrationEventDelivery,
  providerThreadProcessedConsumerName,
  type BlockedOrchestrationEventDeliveryState,
  type OrchestrationEventDeliveryState,
} from "../Services/OrchestrationEventDeliveries.ts";
import { OrchestrationEventDeliveryRepositoryLive } from "./OrchestrationEventDeliveries.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import DurableProviderCommandDeliveryMigration from "../Migrations/064_DurableProviderCommandDelivery.ts";
import ProviderDeliveryReconciliationMigration from "../Migrations/067_ProviderDeliveryReconciliation.ts";

const layer = it.layer(
  OrchestrationEventDeliveryRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventDeliveryRepository", (it) => {
  it.effect("pages stored event sequences across gaps without loading payloads or moving ACK", () =>
    Effect.gen(function* () {
      const repository = yield* OrchestrationEventDeliveryRepository;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();
      yield* DurableProviderCommandDeliveryMigration;
      const rows = yield* sql<{ sequence: number }>`
        WITH RECURSIVE events(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM events WHERE n < 4)
        INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version,
          event_type, occurred_at, command_id, actor_kind, payload_json, metadata_json)
        SELECT 'sequence-page-' || n, 'thread', 'sequence-page', n, 'thread.activity-appended',
          ${now}, 'sequence-page-' || n, 'user', 'unreadable payload', '{}' FROM events
        RETURNING sequence`;
      const [first, deleted, third, fourth] = rows;
      assert.isDefined(first);
      assert.isDefined(deleted);
      assert.isDefined(third);
      assert.isDefined(fourth);
      yield* sql`DELETE FROM orchestration_events WHERE sequence = ${deleted!.sequence}`;
      const read = (after: number, through = fourth!.sequence, limit = 2) =>
        repository.readEventSequencePage({
          sequenceExclusive: after,
          throughSequenceInclusive: through,
          limit,
        });
      assert.deepEqual(yield* read(first!.sequence - 1), [first, third]);
      assert.deepEqual(yield* read(third!.sequence), [fourth]);
      assert.deepEqual(yield* read(first!.sequence, third!.sequence), [third]);
      assert.deepEqual(yield* read(fourth!.sequence), []);
      assert.strictEqual(
        Option.getOrThrow(yield* repository.getConsumerState(PROVIDER_COMMAND_REACTOR_CONSUMER))
          .lastAckedSequence,
        0,
      );
      yield* sql`DELETE FROM orchestration_events WHERE stream_id = 'sequence-page'`;
    }),
  );

  it.effect("persists a monotonic thread quarantine fence without moving the global cursor", () =>
    Effect.gen(function* () {
      const repository = yield* OrchestrationEventDeliveryRepository;
      assert.notStrictEqual(
        providerThreadProcessedConsumerName("\ud800"),
        providerThreadProcessedConsumerName("\ufffd"),
      );
      const sql = yield* SqlClient.SqlClient;
      yield* DurableProviderCommandDeliveryMigration;
      const now = new Date().toISOString();
      const rows = yield* sql<{ sequence: number }>`
      INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json)
      VALUES ('fence-one', 'thread', 'thread-fence', 0, 'thread.turn-start-requested', ${now}, 'fence-one', NULL, NULL, 'user', '{}', '{}'),
             ('fence-two', 'thread', 'thread-fence', 1, 'thread.task-stop-requested', ${now}, 'fence-two', NULL, NULL, 'user', '{}', '{}') RETURNING sequence`;
      const first = rows[0]!.sequence;
      const second = rows[1]!.sequence;
      assert.isFalse(
        yield* repository.recordThreadProcessedSequence({
          threadId: "wrong-thread",
          eventSequence: second,
          updatedAt: now,
        }),
      );
      assert.isFalse(
        yield* repository.recordThreadProcessedSequence({
          threadId: "thread-fence",
          eventSequence: second + 1000,
          updatedAt: now,
        }),
      );
      assert.isTrue(
        yield* repository.recordThreadProcessedSequence({
          threadId: "thread-fence",
          eventSequence: second,
          updatedAt: now,
        }),
      );
      assert.isTrue(
        yield* repository.recordThreadProcessedSequence({
          threadId: "thread-fence",
          eventSequence: first,
          updatedAt: now,
        }),
      );
      const state = yield* repository.getConsumerState(
        providerThreadProcessedConsumerName("thread-fence"),
      );
      assert.strictEqual(Option.getOrThrow(state).lastAckedSequence, second);
      assert.strictEqual(
        Option.getOrThrow(yield* repository.getConsumerState(PROVIDER_COMMAND_REACTOR_CONSUMER))
          .lastAckedSequence,
        0,
      );
      const count = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_consumer_state WHERE consumer_name LIKE 'provider-command-reactor.thread-processed.v1:%'`;
      assert.strictEqual(count[0]!.count, 1);
      const deleted = yield* sql<{
        sequence: number;
      }>`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json) VALUES ('fence-deleted', 'thread', 'thread-fence', 2, 'thread.deleted', ${now}, 'fence-deleted', NULL, NULL, 'user', '{}', '{}') RETURNING sequence`;
      assert.isTrue(
        yield* repository.recordThreadProcessedSequence({
          threadId: "thread-fence",
          eventSequence: deleted[0]!.sequence,
          updatedAt: now,
        }),
      );
      assert.isTrue(
        Option.isNone(
          yield* repository.getConsumerState(providerThreadProcessedConsumerName("thread-fence")),
        ),
      );
      yield* sql`DELETE FROM orchestration_events WHERE stream_id = 'thread-fence'`;
    }),
  );

  it.effect("claims by reference without copying event payload and completes with its owner", () =>
    Effect.gen(function* () {
      const repository = yield* OrchestrationEventDeliveryRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* DurableProviderCommandDeliveryMigration;
      const now = new Date().toISOString();
      const payload = JSON.stringify({ threadId: "thread-delivery", text: "payload-owned-by-log" });

      const inserted = yield* sql<{ readonly sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'evt-delivery', 'thread', 'thread-delivery', 0, 'thread.turn-start-requested',
          ${now}, 'cmd-delivery', NULL, 'cmd-delivery', 'user', ${payload}, '{}'
        )
        RETURNING sequence
      `;
      const sequence = inserted[0]!.sequence;

      const claimed = yield* repository.claim({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: sequence,
        threadId: "thread-delivery",
        claimOwner: "owner-a",
        claimedAt: now,
        claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      assert.isTrue(Option.isSome(claimed));
      assert.strictEqual(claimed.pipe(Option.getOrThrow).attemptCount, 1);

      const competingClaim = yield* repository.claim({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: sequence,
        threadId: "thread-delivery",
        claimOwner: "owner-b",
        claimedAt: now,
        claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      assert.isTrue(Option.isNone(competingClaim));
      const earlyRequeue = yield* repository.requeueExpired({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: sequence,
        expectedClaimOwner: "owner-a",
        now,
        error: "lease is still live",
      });
      assert.isFalse(earlyRequeue);

      const wrongOwnerRetry = yield* repository.markRetryable({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: sequence,
        expectedClaimOwner: "owner-b",
        error: "must not steal",
        updatedAt: now,
      });
      assert.isFalse(wrongOwnerRetry);
      const wrongOwnerTerminal = yield* repository.markTerminalFailure({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: sequence,
        expectedClaimOwner: "owner-b",
        state: "uncertain",
        error: "must not classify another owner's work",
        updatedAt: now,
      });
      assert.isFalse(wrongOwnerTerminal);

      const later = yield* sql<{ readonly sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'evt-delivery-later', 'project', 'project-delivery-later', 0, 'project.created',
          ${now}, 'cmd-delivery-later', NULL, NULL, 'user', '{}', '{}'
        )
        RETURNING sequence
      `;
      const skipped = yield* repository.advanceCursor({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: later[0]!.sequence,
        updatedAt: now,
      });
      assert.isFalse(skipped);
      yield* repository.claim({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: later[0]!.sequence,
        threadId: "thread-later",
        claimOwner: "owner-later",
        claimedAt: now,
        claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const outOfOrderCompletion = yield* repository.complete({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: later[0]!.sequence,
        claimOwner: "owner-later",
        completedAt: now,
      });
      assert.isTrue(outOfOrderCompletion);
      const outOfOrderDelivery = yield* repository.getDelivery({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: later[0]!.sequence,
      });
      assert.strictEqual(outOfOrderDelivery.pipe(Option.getOrThrow).state, "succeeded");

      const deliveryColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('orchestration_event_deliveries')
      `;
      assert.notInclude(
        deliveryColumns.map((row) => row.name),
        "payload_json",
      );

      const staleCompletion = yield* repository.complete({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: sequence,
        claimOwner: "stale-owner",
        completedAt: now,
      });
      assert.isFalse(staleCompletion);

      const completed = yield* repository.complete({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: sequence,
        claimOwner: "owner-a",
        completedAt: now,
      });
      assert.isTrue(completed);

      const state = yield* repository.getConsumerState(PROVIDER_COMMAND_REACTOR_CONSUMER);
      assert.strictEqual(state.pipe(Option.getOrThrow).lastAckedSequence, sequence);

      yield* sql`DELETE FROM orchestration_events WHERE sequence = ${sequence}`;
      const retained = yield* repository.getDelivery({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: sequence,
      });
      assert.isTrue(Option.isSome(retained));
    }),
  );

  it.effect("reclaims an interrupted retryable claim and retains terminal blockers", () =>
    Effect.gen(function* () {
      const repository = yield* OrchestrationEventDeliveryRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* DurableProviderCommandDeliveryMigration;
      const now = new Date().toISOString();
      const inserted = yield* sql<{ readonly sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'evt-expired-delivery', 'thread', 'thread-expired', 0, 'thread.created',
          ${now}, 'cmd-expired-delivery', NULL, NULL, 'server',
          '{"threadId":"thread-expired"}', '{}'
        )
        RETURNING sequence
      `;
      const sequence = inserted[0]!.sequence;

      yield* repository.claim({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: sequence,
        threadId: "thread-expired",
        claimOwner: "dead-process",
        claimedAt: "2020-01-01T00:00:00.000Z",
        claimExpiresAt: "2020-01-01T00:01:00.000Z",
      });
      const expiredRequeued = yield* repository.requeueExpired({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: sequence,
        expectedClaimOwner: "dead-process",
        now,
        error: "expired lease",
      });
      assert.isTrue(expiredRequeued);
      const reclaimed = yield* repository.claim({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: sequence,
        threadId: "thread-expired",
        claimOwner: "new-process",
        claimedAt: now,
        claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      assert.strictEqual(reclaimed.pipe(Option.getOrThrow).attemptCount, 2);

      yield* repository.markRetryable({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: sequence,
        expectedClaimOwner: "new-process",
        error: "second transient failure",
        updatedAt: now,
      });
      const finalAttempt = yield* repository.claim({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: sequence,
        threadId: "thread-expired",
        claimOwner: "final-process",
        claimedAt: now,
        claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      assert.strictEqual(finalAttempt.pipe(Option.getOrThrow).attemptCount, 3);

      yield* repository.markTerminalFailure({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: sequence,
        expectedClaimOwner: "final-process",
        state: "dead",
        error: "bounded retry budget exhausted",
        updatedAt: now,
      });
      const blocker = yield* repository.firstBlockingDelivery(PROVIDER_COMMAND_REACTOR_CONSUMER);
      assert.strictEqual(blocker.pipe(Option.getOrThrow).state, "dead");
      assert.strictEqual(blocker.pipe(Option.getOrThrow).threadId, "thread-expired");
      const threadBlocker = yield* repository.firstBlockingDeliveryForThread({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        threadId: "thread-expired",
      });
      assert.strictEqual(threadBlocker.pipe(Option.getOrThrow).eventSequence, sequence);
      const unrelatedThread = yield* repository.firstBlockingDeliveryForThread({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        threadId: "thread-unrelated",
      });
      assert.isTrue(Option.isNone(unrelatedThread));
    }),
  );

  it.effect("reconciles an exact blocker with append-only operator evidence", () =>
    Effect.gen(function* () {
      const repository = yield* OrchestrationEventDeliveryRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* DurableProviderCommandDeliveryMigration;
      yield* ProviderDeliveryReconciliationMigration;
      const now = new Date().toISOString();
      const inserted = yield* sql<{ readonly sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'evt-reconcile-delivery', 'thread', 'thread-reconcile', 0,
          'thread.turn-interrupt-requested', ${now}, 'cmd-reconcile-delivery',
          NULL, NULL, 'user', '{"threadId":"thread-reconcile"}', '{}'
        )
        RETURNING sequence
      `;
      const eventSequence = inserted[0]!.sequence;
      yield* repository.claim({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence,
        threadId: "thread-reconcile",
        claimOwner: "owner-reconcile",
        claimedAt: now,
        claimExpiresAt: now,
      });
      yield* repository.markTerminalFailure({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence,
        expectedClaimOwner: "owner-reconcile",
        state: "uncertain",
        error: "provider acceptance is unknown",
        updatedAt: now,
      });

      const blockers = yield* repository.listBlockingDeliveries({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        threadId: "thread-reconcile",
        limit: 10,
      });
      assert.strictEqual(blockers.length, 1);
      assert.strictEqual(blockers[0]?.eventId, "evt-reconcile-delivery");
      assert.strictEqual(blockers[0]?.state, "uncertain");
      assert.strictEqual(
        (yield* repository.listBlockingDeliveries({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          threadId: "thread-reconcile",
          afterEventSequence: eventSequence,
          limit: 10,
        })).length,
        0,
      );

      const stale = yield* repository.reconcile({
        reconciliationId: "reconcile-stale",
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence,
        threadId: "thread-reconcile",
        expectedState: "dead",
        outcome: "safe_retry",
        reconciledBy: "operator-a",
        reconciledAt: now,
      });
      assert.isTrue(Option.isNone(stale));

      const retry = yield* repository.reconcile({
        reconciliationId: "reconcile-retry",
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence,
        threadId: "thread-reconcile",
        expectedState: "uncertain",
        outcome: "safe_retry",
        reconciledBy: "operator-a",
        note: "provider confirms it did not accept the interrupt",
        reconciledAt: now,
      });
      assert.strictEqual(retry.pipe(Option.getOrThrow).state, "retry");

      const retried = yield* repository.claim({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence,
        threadId: "thread-reconcile",
        claimOwner: "owner-retried",
        claimedAt: now,
        claimExpiresAt: now,
      });
      assert.isTrue(Option.isSome(retried));
      yield* repository.markTerminalFailure({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence,
        expectedClaimOwner: "owner-retried",
        state: "dead",
        error: "provider rejected the retried interrupt",
        updatedAt: now,
      });
      const accepted = yield* repository.reconcile({
        reconciliationId: "reconcile-accepted",
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence,
        threadId: "thread-reconcile",
        expectedState: "dead",
        outcome: "accepted",
        reconciledBy: "operator-b",
        reconciledAt: now,
      });
      assert.strictEqual(accepted.pipe(Option.getOrThrow).state, "succeeded");
      assert.strictEqual(
        (yield* repository.listRetryableDeliveries(PROVIDER_COMMAND_REACTOR_CONSUMER)).length,
        0,
      );
      assert.strictEqual(
        (yield* repository.listBlockingDeliveries({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          threadId: "thread-reconcile",
          limit: 10,
        })).length,
        0,
      );
      const auditRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM provider_delivery_reconciliations
        WHERE event_sequence = ${eventSequence}
      `;
      assert.strictEqual(auditRows[0]?.count, 2);
    }),
  );

  // The SQL guards are the authoritative enforcement of the delivery state machine.
  // Drive every repository helper from every state so a guard that drifts from the
  // declared table fails here instead of replaying or silently settling a delivery.
  it.effect("moves a delivery only along the declared lifecycle transitions", () =>
    Effect.gen(function* () {
      const repository = yield* OrchestrationEventDeliveryRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* DurableProviderCommandDeliveryMigration;
      yield* ProviderDeliveryReconciliationMigration;
      const consumerName = "lifecycle-matrix-consumer";
      const owner = "owner-lifecycle";
      const claimedAt = "2026-07-14T00:00:00.000Z";
      const expired = "2026-07-14T00:00:01.000Z";
      const later = "2026-07-14T00:00:02.000Z";
      const isBlocked = (
        state: OrchestrationEventDeliveryState,
      ): state is BlockedOrchestrationEventDeliveryState =>
        (BLOCKED_ORCHESTRATION_EVENT_DELIVERY_STATES as ReadonlyArray<string>).includes(state);
      yield* sql`
        INSERT INTO orchestration_consumer_state (
          consumer_name, last_acked_sequence, created_at, updated_at
        ) VALUES (${consumerName}, 0, ${claimedAt}, ${claimedAt})
      `;

      type Helper = {
        readonly to: OrchestrationEventDeliveryState;
        readonly from: ReadonlyArray<OrchestrationEventDeliveryState>;
        readonly run: (
          eventSequence: number,
          threadId: string,
          from: OrchestrationEventDeliveryState,
        ) => Effect.Effect<unknown, unknown>;
      };
      // Each helper moves a delivery to `to`, but only from the states listed in `from`.
      const helpers: Record<string, Helper> = {
        claim: {
          to: "inflight",
          from: ["retry"],
          run: (eventSequence, threadId) =>
            repository.claim({
              consumerName,
              eventSequence,
              threadId,
              claimOwner: "owner-next",
              claimedAt: later,
              claimExpiresAt: later,
            }),
        },
        markRetryable: {
          to: "retry",
          from: ["inflight"],
          run: (eventSequence) =>
            repository.markRetryable({
              consumerName,
              eventSequence,
              expectedClaimOwner: owner,
              error: "retry",
              updatedAt: later,
            }),
        },
        requeueExpired: {
          to: "retry",
          from: ["inflight"],
          run: (eventSequence) =>
            repository.requeueExpired({
              consumerName,
              eventSequence,
              expectedClaimOwner: owner,
              now: later,
              error: "expired",
            }),
        },
        markDead: {
          to: "dead",
          from: ["inflight"],
          run: (eventSequence) =>
            repository.markTerminalFailure({
              consumerName,
              eventSequence,
              expectedClaimOwner: owner,
              state: "dead",
              error: "dead",
              updatedAt: later,
            }),
        },
        markUncertain: {
          to: "uncertain",
          from: ["inflight"],
          run: (eventSequence) =>
            repository.markTerminalFailure({
              consumerName,
              eventSequence,
              expectedClaimOwner: owner,
              state: "uncertain",
              error: "uncertain",
              updatedAt: later,
            }),
        },
        complete: {
          to: "succeeded",
          from: ["inflight"],
          run: (eventSequence) =>
            repository.complete({
              consumerName,
              eventSequence,
              claimOwner: owner,
              completedAt: later,
            }),
        },
        reconcileSafeRetry: {
          to: "retry",
          from: ["dead", "uncertain"],
          run: (eventSequence, threadId, from) =>
            repository.reconcile({
              reconciliationId: `reconcile-retry-${eventSequence}`,
              consumerName,
              eventSequence,
              threadId,
              expectedState: isBlocked(from) ? from : "dead",
              outcome: "safe_retry",
              reconciledBy: "operator",
              reconciledAt: later,
            }),
        },
        reconcileAccepted: {
          to: "succeeded",
          from: ["dead", "uncertain"],
          run: (eventSequence, threadId, from) =>
            repository.reconcile({
              reconciliationId: `reconcile-accepted-${eventSequence}`,
              consumerName,
              eventSequence,
              threadId,
              expectedState: isBlocked(from) ? from : "dead",
              outcome: "accepted",
              reconciledBy: "operator",
              reconciledAt: later,
            }),
        },
      };

      const states = Object.keys(
        ORCHESTRATION_EVENT_DELIVERY_TRANSITIONS,
      ) as OrchestrationEventDeliveryState[];
      let version = 0;
      for (const [name, helper] of Object.entries(helpers)) {
        for (const from of states) {
          const threadId = `thread-delivery-lifecycle-${name}-${from}`;
          const inserted = yield* sql<{ readonly sequence: number }>`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type,
              occurred_at, command_id, causation_event_id, correlation_id,
              actor_kind, payload_json, metadata_json
            ) VALUES (
              ${`evt-${threadId}`}, 'thread', 'thread-delivery-lifecycle', ${version++},
              'thread.turn-start-requested', ${claimedAt}, ${`cmd-${threadId}`},
              NULL, NULL, 'user', '{}', '{}'
            )
            RETURNING sequence
          `;
          const eventSequence = inserted[0]!.sequence;
          yield* repository.claim({
            consumerName,
            eventSequence,
            threadId,
            claimOwner: owner,
            claimedAt,
            claimExpiresAt: expired,
          });
          // Only an in-flight delivery carries a claim; every write that leaves it clears it.
          yield* sql`
            UPDATE orchestration_event_deliveries
            SET state = ${from},
                claim_owner = ${from === "inflight" ? owner : null},
                claimed_at = ${from === "inflight" ? claimedAt : null},
                claim_expires_at = ${from === "inflight" ? expired : null}
            WHERE consumer_name = ${consumerName} AND event_sequence = ${eventSequence}
          `;

          yield* helper.run(eventSequence, threadId, from);

          const after = yield* repository.getDelivery({ consumerName, eventSequence });
          const acts = helper.from.includes(from);
          assert.strictEqual(
            after.pipe(Option.getOrThrow).state,
            acts ? helper.to : from,
            `${name}: ${from}`,
          );
          if (acts) {
            assert.isTrue(
              canTransitionOrchestrationEventDelivery(from, helper.to),
              `${name}: ${from}`,
            );
          }
        }
      }

      // Every declared edge is realized by a repository helper, except retry -> succeeded,
      // which only CheckpointReactor's proven-receipt settlement writes.
      const receiptOnly = new Set(["retry->succeeded"]);
      for (const from of states) {
        for (const to of ORCHESTRATION_EVENT_DELIVERY_TRANSITIONS[from]) {
          if (receiptOnly.has(`${from}->${to}`)) continue;
          assert.isTrue(
            Object.values(helpers).some((helper) => helper.to === to && helper.from.includes(from)),
            `${from} -> ${to}`,
          );
        }
      }
    }),
  );
});
