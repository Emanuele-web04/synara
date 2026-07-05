/**
 * OrchestrationEngineService - Service interface for orchestration command handling.
 *
 * Owns command validation/dispatch and lightweight command-state updates backed by
 * `OrchestrationEventStore` persistence. It does not own provider process
 * management or transport concerns (e.g. websocket request parsing).
 *
 * Uses Effect `ServiceMap.Service` for dependency injection. Command dispatch,
 * replay, and unknown-input decoding all return typed domain errors.
 *
 * @module OrchestrationEngineService
 */
import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { OrchestrationDispatchError } from "../Errors.ts";
import type {
  OrchestrationEventStoreError,
  ProjectionRepositoryError,
} from "../../persistence/Errors.ts";

/**
 * OrchestrationEngineShape - Service API for orchestration command and event flow.
 */
export interface OrchestrationEngineShape {
  /**
   * Replay persisted orchestration events from an exclusive sequence cursor.
   *
   * @param fromSequenceExclusive - Sequence cursor (exclusive).
   * @returns Stream containing ordered events.
   */
  readonly readEvents: (
    fromSequenceExclusive: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /**
   * Read the command-oriented in-memory model used by orchestration tests and
   * compatibility callers. Runtime snapshot reads should prefer
   * ProjectionSnapshotQuery.
   */
  readonly getReadModel: () => Effect.Effect<OrchestrationReadModel, never, never>;

  /**
   * Dispatch a validated orchestration command.
   *
   * @param command - Valid orchestration command.
   * @returns Effect containing the sequence of the persisted event.
   *
   * Dispatch is serialized through an internal queue and deduplicated via
   * command receipts.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  /**
   * Repair project-facing projection state for older installs without clearing
   * existing chat rows.
   *
   * Replays the snapshot-related projector cursors and refreshes the in-memory
   * command model from projection state.
   */
  readonly repairState: () => Effect.Effect<
    OrchestrationReadModel,
    OrchestrationDispatchError | OrchestrationEventStoreError,
    never
  >;

  /**
   * Reload the command-facing read model from projection tables after
   * maintenance code mutates projection state outside the command queue.
   */
  readonly refreshCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    OrchestrationDispatchError | ProjectionRepositoryError,
    never
  >;

  /**
   * Stream persisted domain events in dispatch order.
   *
   * This is a hot runtime stream (new events only), not a historical replay.
   */
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;
}

/**
 * OrchestrationEngineService - Service tag for orchestration engine access.
 *
 */
export class OrchestrationEngineService extends ServiceMap.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("t3/orchestration/Services/OrchestrationEngine/OrchestrationEngineService") {}
