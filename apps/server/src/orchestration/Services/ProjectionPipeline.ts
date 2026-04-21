/**
 * OrchestrationProjectionPipeline - Event projection pipeline service interface.
 *
 * Coordinates projection bootstrap/replay and per-event projection updates for
 * orchestration read models.
 *
 * @module OrchestrationProjectionPipeline
 */
import type { OrchestrationEvent } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { ProjectMetadataOrchestrationEvent } from "../projectMetadataProjection.ts";

/**
 * OrchestrationProjectionPipelineShape - Service API for projection execution.
 */
export interface OrchestrationProjectionPipelineShape {
  /**
   * Bootstrap projections by replaying persisted events.
   *
   * Resumes each projector from its stored projection-state cursor.
   */
  readonly bootstrap: Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Project a single orchestration event into projection repositories.
   *
   * Projectors are executed sequentially to preserve deterministic ordering.
   */
  readonly projectEvent: (
    event: OrchestrationEvent,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Project only the hot-path repositories required for live transcript and
   * session updates during streaming.
   */
  readonly projectHotEvent: (
    event: OrchestrationEvent,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Project deferred repositories whose derived shell metadata is safe to
   * compute after the main event transaction commits.
   */
  readonly projectDeferredEvent: (
    event: OrchestrationEvent,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Project a single project metadata event while the caller already owns the
   * surrounding transaction.
   */
  readonly projectMetadataEvent: (
    event: ProjectMetadataOrchestrationEvent,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * OrchestrationProjectionPipeline - Service tag for orchestration projections.
 */
export class OrchestrationProjectionPipeline extends ServiceMap.Service<
  OrchestrationProjectionPipeline,
  OrchestrationProjectionPipelineShape
>()("t3/orchestration/Services/ProjectionPipeline/OrchestrationProjectionPipeline") {}
