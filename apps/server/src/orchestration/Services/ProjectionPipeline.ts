import type { OrchestrationEvent } from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { ProjectMetadataOrchestrationEvent } from "../projectMetadataProjection.ts";
import type { SpaceMetadataOrchestrationEvent } from "../spaceMetadataProjection.ts";

export type ShellMetadataOrchestrationEvent =
  | ProjectMetadataOrchestrationEvent
  | SpaceMetadataOrchestrationEvent;

export interface OrchestrationProjectionPipelineShape {
  /** resumes each projector from its stored cursor */
  readonly bootstrap: Effect.Effect<void, ProjectionRepositoryError>;

  /** projectors run sequentially for deterministic ordering */
  readonly projectEvent: (
    event: OrchestrationEvent,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Project the repositories required for live transcript, session and shell
   * notifications before their domain events are published.
   *
   * PRECONDITION: the caller MUST already hold an open transaction. This method
   * performs NO transaction management of its own — it runs the hot projectors
   * directly against the ambient transaction so their writes commit atomically
   * with the caller's. Use `projectEvent` (or another wrapping variant) when no
   * surrounding transaction is held.
   */
  readonly projectHotEventInCurrentTransaction: (
    event: OrchestrationEvent,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** project one metadata event while the caller owns the transaction */
  readonly projectMetadataEvent: (
    event: ShellMetadataOrchestrationEvent,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class OrchestrationProjectionPipeline extends ServiceMap.Service<
  OrchestrationProjectionPipeline,
  OrchestrationProjectionPipelineShape
>()("synara/orchestration/Services/ProjectionPipeline/OrchestrationProjectionPipeline") {}
