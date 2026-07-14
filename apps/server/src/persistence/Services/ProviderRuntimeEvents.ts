import type { ProviderRuntimeEvent } from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const PROVIDER_RUNTIME_INGESTION_CONSUMER = "provider-runtime-ingestion.v1";
export const PROVIDER_RUNTIME_EVENT_MAX_BYTES = 2 * 1024 * 1024;
export const PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED = 512;

export interface PersistedProviderRuntimeEvent {
  readonly sequence: number;
  readonly event: ProviderRuntimeEvent;
}

export type ProviderRuntimeEventRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError;

export interface ProviderRuntimeEventRepositoryShape {
  readonly append: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<PersistedProviderRuntimeEvent, ProviderRuntimeEventRepositoryError>;
  readonly getHighWaterSequence: Effect.Effect<number, PersistenceSqlError>;
  readonly readAfter: (input: {
    readonly sequenceExclusive: number;
    readonly throughSequenceInclusive: number;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<PersistedProviderRuntimeEvent>,
    ProviderRuntimeEventRepositoryError
  >;
  readonly readAcceptedOpenTurnEvents: (input: {
    readonly consumerName: string;
    readonly sequenceExclusive: number;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<PersistedProviderRuntimeEvent>,
    ProviderRuntimeEventRepositoryError
  >;
  readonly getConsumerCursor: (
    consumerName: string,
  ) => Effect.Effect<number, ProviderRuntimeEventRepositoryError>;
  readonly advanceConsumerCursor: (input: {
    readonly consumerName: string;
    readonly eventSequence: number;
    readonly updatedAt: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
}

export class ProviderRuntimeEventRepository extends ServiceMap.Service<
  ProviderRuntimeEventRepository,
  ProviderRuntimeEventRepositoryShape
>()("synara/persistence/Services/ProviderRuntimeEvents/ProviderRuntimeEventRepository") {}
