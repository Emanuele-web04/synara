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

  /** PRECONDITION: caller must already hold a transaction — this runs hot projectors against the ambient transaction so writes commit atomically with the caller's; use projectEvent when no transaction is held */
  readonly projectHotEventInCurrentTransaction: (event: OrchestrationEvent) => Effect.Effect<
    {
      /** true when the deferred phase had no projector and its cursor moved inside the hot transaction — caller must not run a separate deferred pass */
      readonly deferredPhaseSettled: boolean;
    },
    ProjectionRepositoryError
  >;

  /** deferred repositories whose derived shell metadata is safe to compute after the main transaction commits */
  readonly projectDeferredEvent: (
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
