import {
  IsoDateTime,
  OrchestrationProposedPlanId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@synara/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadProposedPlan = Schema.Struct({
  planId: OrchestrationProposedPlanId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime),
  implementationThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadProposedPlan = typeof ProjectionThreadProposedPlan.Type;

export const ProjectionThreadProposedPlanSummary = Schema.Struct({
  planId: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  implementedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type ProjectionThreadProposedPlanSummary = typeof ProjectionThreadProposedPlanSummary.Type;

export const ListProjectionThreadProposedPlansInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadProposedPlansInput =
  typeof ListProjectionThreadProposedPlansInput.Type;

export const GetLatestProjectionThreadProposedPlanSummaryInput = Schema.Struct({
  threadId: ThreadId,
  preferredTurnId: Schema.NullOr(TurnId),
});
export type GetLatestProjectionThreadProposedPlanSummaryInput =
  typeof GetLatestProjectionThreadProposedPlanSummaryInput.Type;

export const DeleteProjectionThreadProposedPlansInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadProposedPlansInput =
  typeof DeleteProjectionThreadProposedPlansInput.Type;

export interface ProjectionThreadProposedPlanRepositoryShape {
  readonly upsert: (
    proposedPlan: ProjectionThreadProposedPlan,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadProposedPlansInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadProposedPlan>, ProjectionRepositoryError>;
  readonly getLatestSummaryByThreadId: (
    input: GetLatestProjectionThreadProposedPlanSummaryInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadProposedPlanSummary>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadProposedPlansInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadProposedPlanRepository extends ServiceMap.Service<
  ProjectionThreadProposedPlanRepository,
  ProjectionThreadProposedPlanRepositoryShape
>()(
  "synara/persistence/Services/ProjectionThreadProposedPlans/ProjectionThreadProposedPlanRepository",
) {}
