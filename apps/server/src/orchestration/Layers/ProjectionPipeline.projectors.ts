// Purpose: Composes the eleven orchestration projector `apply` closures from the
//   thread, turn, and misc sub-factories into one record.
// Layer: dependency-parameterized projector composition; built once per pipeline via makeProjectionProjectors(deps).
// Exports: ProjectionProjectorDeps, ProjectionProjectors, makeProjectionProjectors.

import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepository } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThreadRuntimeRepository } from "../../persistence/Services/ProjectionThreadRuntime.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { makeMiscProjectors } from "./ProjectionPipeline.projectors.misc.ts";
import { makeThreadProjectors } from "./ProjectionPipeline.projectors.threads.ts";
import { makeTurnProjectors } from "./ProjectionPipeline.projectors.turns.ts";

export interface ProjectionProjectorDeps {
  readonly projectionProjectRepository: typeof ProjectionProjectRepository.Service;
  readonly projectionThreadRepository: typeof ProjectionThreadRepository.Service;
  readonly projectionThreadMessageRepository: typeof ProjectionThreadMessageRepository.Service;
  readonly projectionThreadProposedPlanRepository: typeof ProjectionThreadProposedPlanRepository.Service;
  readonly projectionThreadActivityRepository: typeof ProjectionThreadActivityRepository.Service;
  readonly projectionThreadSessionRepository: typeof ProjectionThreadSessionRepository.Service;
  readonly projectionThreadRuntimeRepository: typeof ProjectionThreadRuntimeRepository.Service;
  readonly projectionTurnRepository: typeof ProjectionTurnRepository.Service;
  readonly projectionPendingApprovalRepository: typeof ProjectionPendingApprovalRepository.Service;
}

export type ProjectionProjectors = ReturnType<typeof makeProjectionProjectors>;

export const makeProjectionProjectors = (deps: ProjectionProjectorDeps) => {
  const threadProjectors = makeThreadProjectors(deps);
  const turnProjectors = makeTurnProjectors(deps);
  const miscProjectors = makeMiscProjectors(deps);

  return {
    applyProjectsProjection: miscProjectors.applyProjectsProjection,
    applyThreadsProjection: threadProjectors.applyThreadsProjection,
    applyThreadShellSummariesProjection: threadProjectors.applyThreadShellSummariesProjection,
    applyThreadMessagesProjection: threadProjectors.applyThreadMessagesProjection,
    applyThreadProposedPlansProjection: threadProjectors.applyThreadProposedPlansProjection,
    applyThreadActivitiesProjection: threadProjectors.applyThreadActivitiesProjection,
    applyThreadSessionsProjection: threadProjectors.applyThreadSessionsProjection,
    applyThreadTurnsProjection: turnProjectors.applyThreadTurnsProjection,
    applyCheckpointsProjection: miscProjectors.applyCheckpointsProjection,
    applyPendingApprovalsProjection: miscProjectors.applyPendingApprovalsProjection,
    applyThreadRuntimeProjection: miscProjectors.applyThreadRuntimeProjection,
  };
};
