import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface QueuedTurnPromotion {
  readonly queuedEventSequence: number;
  readonly threadId: string;
  readonly messageId: string;
  readonly dispatchMode: "queue" | "steer";
  readonly state: "queued" | "promoting" | "promoted" | "cancelled";
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
