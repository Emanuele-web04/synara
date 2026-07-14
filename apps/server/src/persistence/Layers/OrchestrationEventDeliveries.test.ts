import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  OrchestrationEventDeliveryRepository,
  PROVIDER_COMMAND_REACTOR_CONSUMER,
} from "../Services/OrchestrationEventDeliveries.ts";
import { OrchestrationEventDeliveryRepositoryLive } from "./OrchestrationEventDeliveries.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import DurableProviderCommandDeliveryMigration from "../Migrations/064_DurableProviderCommandDelivery.ts";
import ProviderDeliveryReconciliationMigration from "../Migrations/067_ProviderDeliveryReconciliation.ts";

const layer = it.layer(
  OrchestrationEventDeliveryRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventDeliveryRepository", (it) => {
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
      assert.notInclude(deliveryColumns.map((row) => row.name), "payload_json");

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
      const blocker = yield* repository.firstBlockingDelivery(
        PROVIDER_COMMAND_REACTOR_CONSUMER,
      );
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
});
