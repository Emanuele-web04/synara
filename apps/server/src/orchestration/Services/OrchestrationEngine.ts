import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect, Scope, Stream } from "effect";

import type { OrchestrationDispatchError } from "../Errors.ts";
import type {
  OrchestrationEventStoreError,
  ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import type { ManagedAttachmentPrincipal } from "../../managedAttachmentPrincipal.ts";

export interface OrchestrationDispatchContext {
  readonly attachmentPrincipal?: ManagedAttachmentPrincipal;
  /** Resolve an uncertain turn start, durably rejecting it if it has not committed. Never execute it. */
  readonly settleOnly?: boolean;
}

export interface OrchestrationProjectionCatchUpStatus {
  /** "unknown" means the lag probe itself failed — the projection may be fine or badly broken, and either extreme would mislead a monitor */
  readonly state: "healthy" | "degraded" | "unknown";
  readonly inFlight: boolean;
  readonly retryAttempts: number;
  readonly lastFailure: string | null;
  /** journal head the per-projector lag is measured against */
  readonly highWaterSequence: number;
  /** events behind the journal head per projector; only lagging ones appear */
  readonly lagByProjector: Readonly<Record<string, number>>;
  /** cursors absent from a non-empty projection_state (interrupted repair) */
  readonly missingProjectors: ReadonlyArray<string>;
}

export interface OrchestrationEngineShape {
  /** reject new normal mutations while retaining reserved lifecycle progress */
  readonly quiesce: Effect.Effect<void>;

  /** Resolve after admitted commands finish their hot commit and ordered publication. */
  readonly drain: Effect.Effect<void>;

  /** Reject all admission, finish admitted commands, then stop the command workers. */
  readonly stop: Effect.Effect<void>;

  /** Current supervised projection-recovery state for health and diagnostics. */
  readonly getProjectionCatchUpStatus: Effect.Effect<OrchestrationProjectionCatchUpStatus>;

  readonly readEvents: (
    fromSequenceExclusive: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /** Read a durable inclusive range; an optional limit bounds SQL fetches and eager decoding. */
  readonly readEventsThrough: (
    fromSequenceExclusive: number,
    throughSequenceInclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  readonly readThreadEvents: (
    threadId: string,
    fromSequenceExclusive: number,
    eventTypes?: ReadonlyArray<string>,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /** Read one thread's inclusive range, filtering event types before the optional SQL limit. */
  readonly readThreadEventsThrough: (
    threadId: string,
    fromSequenceExclusive: number,
    throughSequenceInclusive: number,
    eventTypes?: ReadonlyArray<string>,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  readonly getEventHighWaterSequence: Effect.Effect<number, OrchestrationEventStoreError>;

  readonly getThreadTitleHighWaterSequence: (
    threadId: string,
  ) => Effect.Effect<number, OrchestrationEventStoreError>;

  /** subscribers register before the stream returns — transport snapshot handshakes use this exact boundary to close replay gaps */
  readonly subscribeDomainEvents: Effect.Effect<
    Stream.Stream<OrchestrationEvent>,
    never,
    Scope.Scope
  >;

  /** runtime snapshot reads should prefer ProjectionSnapshotQuery */
  readonly getReadModel: () => Effect.Effect<OrchestrationReadModel, never, never>;

  /**
   * Dispatch a validated orchestration command.
   *
   * @param command - Valid orchestration command.
   * @returns Effect containing the sequence of the persisted event.
   *
   * Dispatch preserves FIFO within each thread/project/space aggregate and
   * bounds concurrency across independent aggregates. Receipts deduplicate
   * retries. Success follows the atomic event/receipt/hot-projection commit and
   * ordered publication. `drain` waits for admitted command work to settle.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
    context?: OrchestrationDispatchContext,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  /** replays snapshot-related cursors and refreshes the command model — for older installs without clearing chat rows */
  readonly repairState: () => Effect.Effect<
    OrchestrationReadModel,
    OrchestrationDispatchError | OrchestrationEventStoreError,
    never
  >;

  /** reload the command read model after maintenance mutates projection state outside the command queue */
  readonly refreshCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    OrchestrationDispatchError | ProjectionRepositoryError,
    never
  >;

  /** hot runtime stream — new events only, not historical replay */
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;
}

export class OrchestrationEngineService extends ServiceMap.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("synara/orchestration/Services/OrchestrationEngine/OrchestrationEngineService") {}
