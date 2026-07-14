import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  QueuedTurnPromotionRepository,
  type QueuedTurnPromotion,
  type QueuedTurnPromotionRepositoryShape,
} from "../Services/QueuedTurnPromotions.ts";

const columns = (sql: SqlClient.SqlClient) => sql`
  queued_event_sequence AS "queuedEventSequence",
  thread_id AS "threadId",
  message_id AS "messageId",
  dispatch_mode AS "dispatchMode",
  state,
  claim_owner AS "claimOwner",
  attempt_count AS "attemptCount"
`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getBySequence: QueuedTurnPromotionRepositoryShape["getBySequence"] =
    (queuedEventSequence) =>
      sql<QueuedTurnPromotion>`
        SELECT ${columns(sql)}
        FROM queued_turn_promotions
        WHERE queued_event_sequence = ${queuedEventSequence}
      `.pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(toPersistenceSqlError("QueuedTurnPromotion.getBySequence")),
      );

  const enqueue: QueuedTurnPromotionRepositoryShape["enqueue"] = (input) =>
    sql`
      INSERT INTO queued_turn_promotions (
        queued_event_sequence, thread_id, message_id, dispatch_mode, state,
        claim_owner, claimed_at, claim_expires_at, attempt_count,
        created_at, updated_at, promoted_at
      ) VALUES (
        ${input.queuedEventSequence}, ${input.threadId}, ${input.messageId},
        ${input.dispatchMode}, 'queued', NULL, NULL, NULL, 0,
        ${input.createdAt}, ${input.createdAt}, NULL
      )
      ON CONFLICT DO UPDATE SET
        queued_event_sequence = excluded.queued_event_sequence,
        dispatch_mode = excluded.dispatch_mode,
        state = 'queued',
        claim_owner = NULL,
        claimed_at = NULL,
        claim_expires_at = NULL,
        attempt_count = 0,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        promoted_at = NULL
      WHERE queued_turn_promotions.state IN ('promoted', 'cancelled')
        AND excluded.queued_event_sequence > queued_turn_promotions.queued_event_sequence
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("QueuedTurnPromotion.enqueue")),
    );

  const claimNext: QueuedTurnPromotionRepositoryShape["claimNext"] = (input) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          UPDATE queued_turn_promotions
          SET state = 'queued', claim_owner = NULL, claimed_at = NULL,
              claim_expires_at = NULL, updated_at = ${input.claimedAt}
          WHERE thread_id = ${input.threadId}
            AND state = 'promoting'
            AND (
              claim_expires_at <= ${input.claimedAt}
              OR claim_owner <> ${input.claimOwner}
            )
        `;
        const candidates = yield* sql<{ readonly queuedEventSequence: number }>`
          SELECT queued_event_sequence AS "queuedEventSequence"
          FROM queued_turn_promotions
          WHERE thread_id = ${input.threadId} AND state = 'queued'
          ORDER BY
            CASE dispatch_mode WHEN 'steer' THEN 0 ELSE 1 END ASC,
            CASE WHEN dispatch_mode = 'steer' THEN queued_event_sequence END DESC,
            queued_event_sequence ASC
          LIMIT 1
        `;
        const sequence = candidates[0]?.queuedEventSequence;
        if (sequence === undefined) return Option.none<QueuedTurnPromotion>();
        const rows = yield* sql<QueuedTurnPromotion>`
          UPDATE queued_turn_promotions
          SET state = 'promoting', claim_owner = ${input.claimOwner},
              claimed_at = ${input.claimedAt}, claim_expires_at = ${input.claimExpiresAt},
              attempt_count = attempt_count + 1, updated_at = ${input.claimedAt}
          WHERE queued_event_sequence = ${sequence} AND state = 'queued'
          RETURNING ${columns(sql)}
        `;
        return Option.fromNullishOr(rows[0]);
      }),
    ).pipe(Effect.mapError(toPersistenceSqlError("QueuedTurnPromotion.claimNext")));

  const markPromoted: QueuedTurnPromotionRepositoryShape["markPromoted"] = (input) =>
    sql<{ readonly sequence: number }>`
      UPDATE queued_turn_promotions
      SET state = 'promoted', claim_owner = NULL, claimed_at = NULL,
          claim_expires_at = NULL, promoted_at = ${input.promotedAt},
          updated_at = ${input.promotedAt}
      WHERE queued_event_sequence = ${input.queuedEventSequence}
        AND state = 'promoting' AND claim_owner = ${input.claimOwner}
      RETURNING queued_event_sequence AS sequence
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError("QueuedTurnPromotion.markPromoted")),
    );

  const releaseClaim: QueuedTurnPromotionRepositoryShape["releaseClaim"] = (input) =>
    sql<{ readonly sequence: number }>`
      UPDATE queued_turn_promotions
      SET state = 'queued', claim_owner = NULL, claimed_at = NULL,
          claim_expires_at = NULL, updated_at = ${input.updatedAt}
      WHERE queued_event_sequence = ${input.queuedEventSequence}
        AND state = 'promoting' AND claim_owner = ${input.claimOwner}
      RETURNING queued_event_sequence AS sequence
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError("QueuedTurnPromotion.releaseClaim")),
    );

  const cancelMessage: QueuedTurnPromotionRepositoryShape["cancelMessage"] = (input) =>
    sql<{ readonly sequence: number }>`
      UPDATE queued_turn_promotions
      SET state = 'cancelled', claim_owner = NULL, claimed_at = NULL,
          claim_expires_at = NULL, updated_at = ${input.updatedAt}
      WHERE thread_id = ${input.threadId} AND message_id = ${input.messageId}
        AND state = 'queued'
      RETURNING queued_event_sequence AS sequence
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError("QueuedTurnPromotion.cancelMessage")),
    );

  const cancelThread: QueuedTurnPromotionRepositoryShape["cancelThread"] = (input) =>
    sql`
      UPDATE queued_turn_promotions
      SET state = 'cancelled', claim_owner = NULL, claimed_at = NULL,
          claim_expires_at = NULL, updated_at = ${input.updatedAt}
      WHERE thread_id = ${input.threadId} AND state = 'queued'
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("QueuedTurnPromotion.cancelThread")),
    );

  const hasPendingMessage: QueuedTurnPromotionRepositoryShape["hasPendingMessage"] = (input) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM queued_turn_promotions
      WHERE thread_id = ${input.threadId} AND message_id = ${input.messageId}
        AND state IN ('queued', 'promoting')
    `.pipe(
      Effect.map((rows) => (rows[0]?.count ?? 0) > 0),
      Effect.mapError(toPersistenceSqlError("QueuedTurnPromotion.hasPendingMessage")),
    );

  const listPendingThreadIds = sql<{ readonly threadId: string }>`
    SELECT DISTINCT thread_id AS "threadId"
    FROM queued_turn_promotions
    WHERE state IN ('queued', 'promoting')
    ORDER BY thread_id ASC
  `.pipe(
    Effect.map((rows) => rows.map((row) => row.threadId)),
    Effect.mapError(toPersistenceSqlError("QueuedTurnPromotion.listPendingThreadIds")),
  );

  return {
    getBySequence,
    enqueue,
    claimNext,
    markPromoted,
    releaseClaim,
    cancelMessage,
    cancelThread,
    hasPendingMessage,
    listPendingThreadIds,
  } satisfies QueuedTurnPromotionRepositoryShape;
});

export const QueuedTurnPromotionRepositoryLive = Layer.effect(
  QueuedTurnPromotionRepository,
  make,
);
