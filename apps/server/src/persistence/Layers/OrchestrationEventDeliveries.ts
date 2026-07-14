import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  OrchestrationConsumerState,
  OrchestrationEventDelivery,
  OrchestrationEventDeliveryRepository,
  ProviderBlockingDeliveryEvidence,
  type OrchestrationEventDeliveryRepositoryShape,
} from "../Services/OrchestrationEventDeliveries.ts";

const deliveryColumns = (sql: SqlClient.SqlClient) => sql`
  consumer_name AS "consumerName",
  event_sequence AS "eventSequence",
  thread_id AS "threadId",
  state,
  claim_owner AS "claimOwner",
  claimed_at AS "claimedAt",
  claim_expires_at AS "claimExpiresAt",
  attempt_count AS "attemptCount",
  last_error AS "lastError",
  completed_at AS "completedAt",
  updated_at AS "updatedAt"
`;

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getConsumerStateRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: OrchestrationConsumerState,
    execute: (consumerName) => sql`
      SELECT
        consumer_name AS "consumerName",
        last_acked_sequence AS "lastAckedSequence",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM orchestration_consumer_state
      WHERE consumer_name = ${consumerName}
    `,
  });

  const getDeliveryRow = (consumerName: string, eventSequence: number) =>
    sql<OrchestrationEventDelivery>`
      SELECT ${deliveryColumns(sql)}
      FROM orchestration_event_deliveries
      WHERE consumer_name = ${consumerName}
        AND event_sequence = ${eventSequence}
    `;

  const getConsumerState: OrchestrationEventDeliveryRepositoryShape["getConsumerState"] =
    (consumerName) =>
      getConsumerStateRow(consumerName).pipe(
        Effect.mapError(toPersistenceSqlError("OrchestrationEventDelivery.getConsumerState")),
      );

  const getDelivery: OrchestrationEventDeliveryRepositoryShape["getDelivery"] = (input) =>
    getDeliveryRow(input.consumerName, input.eventSequence).pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.mapError(toPersistenceSqlError("OrchestrationEventDelivery.getDelivery")),
    );

  const claim: OrchestrationEventDeliveryRepositoryShape["claim"] = (input) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO orchestration_event_deliveries (
            consumer_name, event_sequence, thread_id, state,
            claim_owner, claimed_at, claim_expires_at,
            attempt_count, last_error, completed_at, updated_at
          ) VALUES (
            ${input.consumerName}, ${input.eventSequence}, ${input.threadId}, 'inflight',
            ${input.claimOwner}, ${input.claimedAt}, ${input.claimExpiresAt},
            1, NULL, NULL, ${input.claimedAt}
          )
          ON CONFLICT (consumer_name, event_sequence) DO UPDATE SET
            state = 'inflight',
            claim_owner = excluded.claim_owner,
            claimed_at = excluded.claimed_at,
            claim_expires_at = excluded.claim_expires_at,
            attempt_count = orchestration_event_deliveries.attempt_count + 1,
            last_error = NULL,
            updated_at = excluded.updated_at
          WHERE orchestration_event_deliveries.state = 'retry'
        `;
        const rows = yield* getDeliveryRow(input.consumerName, input.eventSequence);
        const delivery = rows[0];
        return delivery?.state === "inflight" && delivery.claimOwner === input.claimOwner
          ? Option.some(delivery)
          : Option.none();
      }),
    ).pipe(Effect.mapError(toPersistenceSqlError("OrchestrationEventDelivery.claim")));

  const markRetryable: OrchestrationEventDeliveryRepositoryShape["markRetryable"] = (input) =>
    sql<{ readonly eventSequence: number }>`
      UPDATE orchestration_event_deliveries
      SET state = 'retry',
          claim_owner = NULL,
          claimed_at = NULL,
          claim_expires_at = NULL,
          last_error = ${input.error},
          updated_at = ${input.updatedAt}
      WHERE consumer_name = ${input.consumerName}
        AND event_sequence = ${input.eventSequence}
        AND state = 'inflight'
        AND claim_owner = ${input.expectedClaimOwner}
      RETURNING event_sequence AS "eventSequence"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError("OrchestrationEventDelivery.markRetryable")),
    );

  const markTerminalFailure: OrchestrationEventDeliveryRepositoryShape["markTerminalFailure"] =
    (input) =>
      sql<{ readonly eventSequence: number }>`
        UPDATE orchestration_event_deliveries
        SET state = ${input.state},
            claim_owner = NULL,
            claimed_at = NULL,
            claim_expires_at = NULL,
            last_error = ${input.error},
            updated_at = ${input.updatedAt}
        WHERE consumer_name = ${input.consumerName}
          AND event_sequence = ${input.eventSequence}
          AND state IN ('inflight', 'retry')
          AND claim_owner = ${input.expectedClaimOwner}
        RETURNING event_sequence AS "eventSequence"
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(toPersistenceSqlError("OrchestrationEventDelivery.markTerminalFailure")),
      );

  const requeueExpired: OrchestrationEventDeliveryRepositoryShape["requeueExpired"] = (input) =>
    sql<{ readonly eventSequence: number }>`
      UPDATE orchestration_event_deliveries
      SET state = 'retry',
          claim_owner = NULL,
          claimed_at = NULL,
          claim_expires_at = NULL,
          last_error = ${input.error},
          updated_at = ${input.now}
      WHERE consumer_name = ${input.consumerName}
        AND event_sequence = ${input.eventSequence}
        AND state = 'inflight'
        AND claim_owner = ${input.expectedClaimOwner}
        AND claim_expires_at <= ${input.now}
      RETURNING event_sequence AS "eventSequence"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError("OrchestrationEventDelivery.requeueExpired")),
    );

  const advanceCursor: OrchestrationEventDeliveryRepositoryShape["advanceCursor"] = (input) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const nextRows = yield* sql<{ readonly nextSequence: number | null }>`
          SELECT MIN(sequence) AS "nextSequence"
          FROM orchestration_events
          WHERE sequence > (
            SELECT last_acked_sequence
            FROM orchestration_consumer_state
            WHERE consumer_name = ${input.consumerName}
          )
        `;
        if (nextRows[0]?.nextSequence !== input.eventSequence) {
          return false;
        }
        const advanced = yield* sql<{ readonly consumerName: string }>`
          UPDATE orchestration_consumer_state
          SET last_acked_sequence = ${input.eventSequence},
              updated_at = ${input.updatedAt}
          WHERE consumer_name = ${input.consumerName}
          RETURNING consumer_name AS "consumerName"
        `;
        return advanced.length === 1;
      }),
    ).pipe(Effect.mapError(toPersistenceSqlError("OrchestrationEventDelivery.advanceCursor")));

  const complete: OrchestrationEventDeliveryRepositoryShape["complete"] = (input) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const completed = yield* sql<{ readonly eventSequence: number }>`
          UPDATE orchestration_event_deliveries
          SET state = 'succeeded',
              claim_owner = NULL,
              claimed_at = NULL,
              claim_expires_at = NULL,
              completed_at = ${input.completedAt},
              updated_at = ${input.completedAt}
          WHERE consumer_name = ${input.consumerName}
            AND event_sequence = ${input.eventSequence}
            AND state = 'inflight'
            AND claim_owner = ${input.claimOwner}
          RETURNING event_sequence AS "eventSequence"
        `;
        if (completed.length === 0) {
          return false;
        }
        const nextRows = yield* sql<{ readonly nextSequence: number | null }>`
          SELECT MIN(sequence) AS "nextSequence"
          FROM orchestration_events
          WHERE sequence > (
            SELECT last_acked_sequence
            FROM orchestration_consumer_state
            WHERE consumer_name = ${input.consumerName}
          )
        `;
        if (nextRows[0]?.nextSequence === input.eventSequence) {
          yield* sql`
            UPDATE orchestration_consumer_state
            SET last_acked_sequence = ${input.eventSequence},
                updated_at = ${input.completedAt}
            WHERE consumer_name = ${input.consumerName}
          `;
        }
        return true;
      }),
    ).pipe(Effect.mapError(toPersistenceSqlError("OrchestrationEventDelivery.complete")));

  const firstBlockingDelivery: OrchestrationEventDeliveryRepositoryShape["firstBlockingDelivery"] =
    (consumerName) =>
      sql<OrchestrationEventDelivery>`
        SELECT ${deliveryColumns(sql)}
        FROM orchestration_event_deliveries
        WHERE consumer_name = ${consumerName}
          AND state IN ('dead', 'uncertain')
        ORDER BY event_sequence ASC
        LIMIT 1
      `.pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(
          toPersistenceSqlError("OrchestrationEventDelivery.firstBlockingDelivery"),
        ),
      );

  const firstBlockingDeliveryForThread: OrchestrationEventDeliveryRepositoryShape["firstBlockingDeliveryForThread"] =
    (input) =>
      sql<OrchestrationEventDelivery>`
        SELECT ${deliveryColumns(sql)}
        FROM orchestration_event_deliveries
        WHERE consumer_name = ${input.consumerName}
          AND thread_id = ${input.threadId}
          AND state IN ('dead', 'uncertain')
        ORDER BY event_sequence ASC
        LIMIT 1
      `.pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(
          toPersistenceSqlError(
            "OrchestrationEventDelivery.firstBlockingDeliveryForThread",
          ),
        ),
      );

  const listBlockingDeliveries: OrchestrationEventDeliveryRepositoryShape["listBlockingDeliveries"] =
    (input) => {
      const threadFilter =
        input.threadId === undefined ? sql`` : sql`AND d.thread_id = ${input.threadId}`;
      return sql<ProviderBlockingDeliveryEvidence>`
        SELECT
          d.consumer_name AS "consumerName",
          d.event_sequence AS "eventSequence",
          e.event_id AS "eventId",
          e.event_type AS "eventType",
          e.occurred_at AS "occurredAt",
          d.thread_id AS "threadId",
          d.state,
          d.attempt_count AS "attemptCount",
          d.last_error AS "lastError",
          d.updated_at AS "updatedAt",
          r.outcome AS "lastReconciliationOutcome",
          r.reconciled_at AS "lastReconciledAt",
          r.reconciled_by AS "lastReconciledBy",
          r.note AS "lastReconciliationNote"
        FROM orchestration_event_deliveries d
        INNER JOIN orchestration_events e ON e.sequence = d.event_sequence
        LEFT JOIN provider_delivery_reconciliations r
          ON r.reconciliation_id = (
            SELECT r2.reconciliation_id
            FROM provider_delivery_reconciliations r2
            WHERE r2.consumer_name = d.consumer_name
              AND r2.event_sequence = d.event_sequence
            ORDER BY r2.reconciled_at DESC, r2.reconciliation_id DESC
            LIMIT 1
          )
        WHERE d.consumer_name = ${input.consumerName}
          AND d.state IN ('dead', 'uncertain')
          ${threadFilter}
        ORDER BY d.event_sequence ASC
        LIMIT ${input.limit}
      `.pipe(
        Effect.mapError(
          toPersistenceSqlError("OrchestrationEventDelivery.listBlockingDeliveries"),
        ),
      );
    };

  const listRetryableDeliveries: OrchestrationEventDeliveryRepositoryShape["listRetryableDeliveries"] =
    (consumerName) =>
      sql<OrchestrationEventDelivery>`
        SELECT ${deliveryColumns(sql)}
        FROM orchestration_event_deliveries
        WHERE consumer_name = ${consumerName}
          AND event_sequence <= (
            SELECT last_acked_sequence
            FROM orchestration_consumer_state
            WHERE consumer_name = ${consumerName}
          )
          AND state IN ('retry', 'inflight')
          AND EXISTS (
            SELECT 1
            FROM provider_delivery_reconciliations r
            WHERE r.consumer_name = orchestration_event_deliveries.consumer_name
              AND r.event_sequence = orchestration_event_deliveries.event_sequence
              AND r.outcome = 'safe_retry'
          )
        ORDER BY event_sequence ASC
      `.pipe(
        Effect.mapError(
          toPersistenceSqlError("OrchestrationEventDelivery.listRetryableDeliveries"),
        ),
      );

  const reconcile: OrchestrationEventDeliveryRepositoryShape["reconcile"] = (input) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const candidates = yield* sql<{
          readonly state: "dead" | "uncertain";
        }>`
          SELECT state
          FROM orchestration_event_deliveries
          WHERE consumer_name = ${input.consumerName}
            AND event_sequence = ${input.eventSequence}
            AND thread_id = ${input.threadId}
            AND state = ${input.expectedState}
        `;
        if (candidates.length !== 1) return Option.none<OrchestrationEventDelivery>();

        yield* sql`
          INSERT INTO provider_delivery_reconciliations (
            reconciliation_id, consumer_name, event_sequence, thread_id,
            previous_state, outcome, reconciled_by, note, reconciled_at
          ) VALUES (
            ${input.reconciliationId}, ${input.consumerName}, ${input.eventSequence},
            ${input.threadId}, ${input.expectedState}, ${input.outcome},
            ${input.reconciledBy}, ${input.note ?? null}, ${input.reconciledAt}
          )
        `;

        yield* sql`
          UPDATE orchestration_event_deliveries
          SET state = ${input.outcome === "safe_retry" ? "retry" : "succeeded"},
              claim_owner = NULL,
              claimed_at = NULL,
              claim_expires_at = NULL,
              completed_at = ${input.outcome === "safe_retry" ? null : input.reconciledAt},
              updated_at = ${input.reconciledAt}
          WHERE consumer_name = ${input.consumerName}
            AND event_sequence = ${input.eventSequence}
            AND thread_id = ${input.threadId}
            AND state = ${input.expectedState}
        `;
        const rows = yield* getDeliveryRow(input.consumerName, input.eventSequence);
        return Option.fromNullishOr(rows[0]);
      }),
    ).pipe(Effect.mapError(toPersistenceSqlError("OrchestrationEventDelivery.reconcile")));

  return {
    getConsumerState,
    getDelivery,
    claim,
    markRetryable,
    requeueExpired,
    markTerminalFailure,
    complete,
    advanceCursor,
    firstBlockingDelivery,
    firstBlockingDeliveryForThread,
    listBlockingDeliveries,
    listRetryableDeliveries,
    reconcile,
  } satisfies OrchestrationEventDeliveryRepositoryShape;
});

export const OrchestrationEventDeliveryRepositoryLive = Layer.effect(
  OrchestrationEventDeliveryRepository,
  makeRepository,
);
