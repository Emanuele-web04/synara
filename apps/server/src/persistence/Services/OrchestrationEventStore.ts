import { OrchestrationEvent } from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { OrchestrationEventStoreError } from "../Errors.ts";

export interface OrchestrationEventReplayFilter {
  readonly eventTypes: ReadonlyArray<OrchestrationEvent["type"]>;
  readonly activityKinds?: ReadonlyArray<string>;
  readonly includeBoundaryEvent?: boolean;
}

export interface OrchestrationEventStoreShape {
  readonly append: (
    event: Omit<OrchestrationEvent, "sequence">,
  ) => Effect.Effect<OrchestrationEvent, OrchestrationEventStoreError>;

  /** latest durable sequence for a finite replay fence */
  readonly getHighWaterSequence: () => Effect.Effect<number, OrchestrationEventStoreError>;

  readonly getThreadHighWaterSequence: (
    threadId: string,
  ) => Effect.Effect<number, OrchestrationEventStoreError>;

  /** latest durable sequence that assigned this thread's title */
  readonly getThreadTitleHighWaterSequence: (
    threadId: string,
  ) => Effect.Effect<number, OrchestrationEventStoreError>;

  /** one stable, newest-first page from a thread's durable stream */
  readonly readThreadEvents: (input: {
    readonly threadId: string;
    readonly throughSequenceInclusive: number;
    readonly beforeSequenceExclusive?: number;
    readonly limit: number;
    readonly eventTypes?: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, OrchestrationEventStoreError>;

  /** replay one thread's events after an exclusive global cursor */
  readonly readThreadEventsFromSequence: (
    threadId: string,
    sequenceExclusive: number,
    limit?: number,
    throughSequenceInclusive?: number,
    eventTypes?: ReadonlyArray<string>,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /** fixed-size pages; normalizes non-integer/negative limits */
  readonly readFromSequence: (
    sequenceExclusive: number,
    limit?: number,
    throughSequenceInclusive?: number,
    filter?: OrchestrationEventReplayFilter,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  readonly readAll: () => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;
}

export class OrchestrationEventStore extends ServiceMap.Service<
  OrchestrationEventStore,
  OrchestrationEventStoreShape
>()("synara/persistence/Services/OrchestrationEventStore") {}
