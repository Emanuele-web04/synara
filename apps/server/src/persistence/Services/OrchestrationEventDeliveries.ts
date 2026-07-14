import { EventId, IsoDateTime, NonNegativeInt, ThreadId } from "@synara/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceSqlError } from "../Errors.ts";

export const PROVIDER_COMMAND_REACTOR_CONSUMER = "provider-command-reactor.v1";

export const OrchestrationEventDeliveryState = Schema.Literals([
  "inflight",
  "retry",
  "succeeded",
  "dead",
  "uncertain",
]);
export type OrchestrationEventDeliveryState = typeof OrchestrationEventDeliveryState.Type;

export const OrchestrationConsumerState = Schema.Struct({
  consumerName: Schema.String,
  lastAckedSequence: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationConsumerState = typeof OrchestrationConsumerState.Type;

export const OrchestrationEventDelivery = Schema.Struct({
  consumerName: Schema.String,
  eventSequence: NonNegativeInt,
  threadId: Schema.String,
  state: OrchestrationEventDeliveryState,
  claimOwner: Schema.NullOr(Schema.String),
  claimedAt: Schema.NullOr(IsoDateTime),
  claimExpiresAt: Schema.NullOr(IsoDateTime),
  attemptCount: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type OrchestrationEventDelivery = typeof OrchestrationEventDelivery.Type;

export const ProviderDeliveryReconciliationOutcome = Schema.Literals([
  "accepted",
  "safe_retry",
  "abandon",
]);
export type ProviderDeliveryReconciliationOutcome =
  typeof ProviderDeliveryReconciliationOutcome.Type;

export const ProviderBlockingDeliveryEvidence = Schema.Struct({
  consumerName: Schema.String,
  eventSequence: NonNegativeInt,
  eventId: EventId,
  eventType: Schema.String,
  occurredAt: IsoDateTime,
  threadId: ThreadId,
  state: Schema.Literals(["dead", "uncertain"]),
  attemptCount: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
  lastReconciliationOutcome: Schema.NullOr(ProviderDeliveryReconciliationOutcome),
  lastReconciledAt: Schema.NullOr(IsoDateTime),
  lastReconciledBy: Schema.NullOr(Schema.String),
  lastReconciliationNote: Schema.NullOr(Schema.String),
});
export type ProviderBlockingDeliveryEvidence = typeof ProviderBlockingDeliveryEvidence.Type;

export interface OrchestrationEventDeliveryRepositoryShape {
  readonly getConsumerState: (
    consumerName: string,
  ) => Effect.Effect<Option.Option<OrchestrationConsumerState>, PersistenceSqlError>;
  readonly getDelivery: (input: {
    readonly consumerName: string;
    readonly eventSequence: number;
  }) => Effect.Effect<Option.Option<OrchestrationEventDelivery>, PersistenceSqlError>;
  readonly claim: (input: {
    readonly consumerName: string;
    readonly eventSequence: number;
    readonly threadId: string;
    readonly claimOwner: string;
    readonly claimedAt: string;
    readonly claimExpiresAt: string;
  }) => Effect.Effect<Option.Option<OrchestrationEventDelivery>, PersistenceSqlError>;
  readonly markRetryable: (input: {
    readonly consumerName: string;
    readonly eventSequence: number;
    readonly expectedClaimOwner: string;
    readonly error: string;
    readonly updatedAt: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly requeueExpired: (input: {
    readonly consumerName: string;
    readonly eventSequence: number;
    readonly expectedClaimOwner: string;
    readonly now: string;
    readonly error: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly markTerminalFailure: (input: {
    readonly consumerName: string;
    readonly eventSequence: number;
    readonly expectedClaimOwner: string;
    readonly state: "dead" | "uncertain";
    readonly error: string;
    readonly updatedAt: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly complete: (input: {
    readonly consumerName: string;
    readonly eventSequence: number;
    readonly claimOwner: string;
    readonly completedAt: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly advanceCursor: (input: {
    readonly consumerName: string;
    readonly eventSequence: number;
    readonly updatedAt: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly firstBlockingDelivery: (
    consumerName: string,
  ) => Effect.Effect<Option.Option<OrchestrationEventDelivery>, PersistenceSqlError>;
  readonly firstBlockingDeliveryForThread: (input: {
    readonly consumerName: string;
    readonly threadId: string;
  }) => Effect.Effect<Option.Option<OrchestrationEventDelivery>, PersistenceSqlError>;
  readonly listBlockingDeliveries: (input: {
    readonly consumerName: string;
    readonly threadId?: string | undefined;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ProviderBlockingDeliveryEvidence>, PersistenceSqlError>;
  readonly listRetryableDeliveries: (
    consumerName: string,
  ) => Effect.Effect<ReadonlyArray<OrchestrationEventDelivery>, PersistenceSqlError>;
  readonly reconcile: (input: {
    readonly reconciliationId: string;
    readonly consumerName: string;
    readonly eventSequence: number;
    readonly threadId: string;
    readonly expectedState: "dead" | "uncertain";
    readonly outcome: ProviderDeliveryReconciliationOutcome;
    readonly reconciledBy: string;
    readonly note?: string | undefined;
    readonly reconciledAt: string;
  }) => Effect.Effect<Option.Option<OrchestrationEventDelivery>, PersistenceSqlError>;
}

export class OrchestrationEventDeliveryRepository extends ServiceMap.Service<
  OrchestrationEventDeliveryRepository,
  OrchestrationEventDeliveryRepositoryShape
>()(
  "synara/persistence/Services/OrchestrationEventDeliveries/OrchestrationEventDeliveryRepository",
) {}
