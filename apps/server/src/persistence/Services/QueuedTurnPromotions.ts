import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceSqlError } from "../Errors.ts";

// A durable promotion row is one queued/steered message waiting to become a turn.
//   pending  -> queued | promoting   (holds the message's slot in the partial unique index)
//   terminal -> promoted | cancelled
//
//   queued ──claimNext──> promoting ──markPromoted (owner)──> promoted
//     ^                     │
//     └──releaseClaim (owner), or claimNext reclaiming an expired/foreign claim
//   queued    ──cancelMessage | cancelThread──> cancelled
//   promoting ──cancelThread──> cancelled      (see `cancelThread` below)
//
// Terminal rows never leave their status. Re-enqueueing the same message with a newer
// event sequence inserts a new row (the partial unique index only covers pending rows).
// The SQL guards in `Layers/QueuedTurnPromotions.ts` enforce this table, and
// `profileStatsArchive.ts` repeats the pending/terminal split as literals; the lifecycle
// matrix in `QueuedTurnPromotions.test.ts` fails when a repository guard drifts from it.
export const PENDING_QUEUED_TURN_PROMOTION_STATES = ["queued", "promoting"] as const;
export const TERMINAL_QUEUED_TURN_PROMOTION_STATES = ["promoted", "cancelled"] as const;

export type QueuedTurnPromotionState =
  | (typeof PENDING_QUEUED_TURN_PROMOTION_STATES)[number]
  | (typeof TERMINAL_QUEUED_TURN_PROMOTION_STATES)[number];

/** Every state a promotion row may move to from the keyed state. */
export const QUEUED_TURN_PROMOTION_TRANSITIONS = {
  queued: ["promoting", "cancelled"],
  promoting: ["queued", "promoted", "cancelled"],
  promoted: [],
  cancelled: [],
} as const satisfies Record<QueuedTurnPromotionState, ReadonlyArray<QueuedTurnPromotionState>>;

export function canTransitionQueuedTurnPromotion(
  from: QueuedTurnPromotionState,
  to: QueuedTurnPromotionState,
): boolean {
  return (
    QUEUED_TURN_PROMOTION_TRANSITIONS[from] as ReadonlyArray<QueuedTurnPromotionState>
  ).includes(to);
}

export interface QueuedTurnPromotion {
  readonly queuedEventSequence: number;
  readonly threadId: string;
  readonly messageId: string;
  readonly dispatchMode: "queue" | "steer";
  readonly state: QueuedTurnPromotionState;
  readonly claimOwner: string | null;
  readonly attemptCount: number;
}

export interface QueuedTurnPromotionRepositoryShape {
  readonly getBySequence: (
    queuedEventSequence: number,
  ) => Effect.Effect<Option.Option<QueuedTurnPromotion>, PersistenceSqlError>;
  readonly enqueue: (input: {
    readonly queuedEventSequence: number;
    readonly threadId: string;
    readonly messageId: string;
    readonly dispatchMode: "queue" | "steer";
    readonly createdAt: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
  readonly claimNext: (input: {
    readonly threadId: string;
    readonly claimOwner: string;
    readonly claimedAt: string;
    readonly claimExpiresAt: string;
  }) => Effect.Effect<Option.Option<QueuedTurnPromotion>, PersistenceSqlError>;
  readonly markPromoted: (input: {
    readonly queuedEventSequence: number;
    readonly claimOwner: string;
    readonly promotedAt: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly releaseClaim: (input: {
    readonly queuedEventSequence: number;
    readonly claimOwner: string;
    readonly updatedAt: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly cancelMessage: (input: {
    readonly threadId: string;
    readonly messageId: string;
    readonly updatedAt: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  /**
   * Cancel all in-flight promotions for a thread. Matches both 'queued' and
   * 'promoting' rows so that a cancellation racing an in-flight drain cannot be
   * resurrected: a cancelled 'promoting' row no longer matches `releaseClaim`
   * (WHERE state='promoting'), so the drain's error path leaves it dead.
   */
  readonly cancelThread: (input: {
    readonly threadId: string;
    readonly updatedAt: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
  readonly hasPendingMessage: (input: {
    readonly threadId: string;
    readonly messageId: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly listPendingThreadIds: Effect.Effect<ReadonlyArray<string>, PersistenceSqlError>;
}

export class QueuedTurnPromotionRepository extends ServiceMap.Service<
  QueuedTurnPromotionRepository,
  QueuedTurnPromotionRepositoryShape
>()("synara/persistence/Services/QueuedTurnPromotions/QueuedTurnPromotionRepository") {}
