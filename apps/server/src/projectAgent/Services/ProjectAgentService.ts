import type {
  ProjectActivity,
  ProjectAgentBackfillInput,
  ProjectAgentConfigureInput,
  ProjectAgentContextPacket,
  ProjectAgentCreateTaskInput,
  ProjectAgentExcludeThreadInput,
  ProjectAgentExportDocumentsInput,
  ProjectAgentExportDocumentsResult,
  ProjectAgentGetOverviewInput,
  ProjectAgentGoalControlInput,
  ProjectAgentListActivityInput,
  ProjectAgentListActivityResult,
  ProjectAgentListDocumentsInput,
  ProjectAgentListDocumentsResult,
  ProjectAgentListEvidenceInput,
  ProjectAgentListEvidenceResult,
  ProjectAgentListTasksInput,
  ProjectAgentListTasksResult,
  ProjectAgentListThreadIndexInput,
  ProjectAgentListThreadIndexResult,
  ProjectAgentOverview,
  ProjectAgentReadDocumentInput,
  ProjectAgentReadDocumentResult,
  ProjectAgentRefreshDigestInput,
  ProjectAgentReportResultInput,
  ProjectAgentStartGoalInput,
  ProjectAgentStreamEvent,
  ProjectAgentSubscribeInput,
  ProjectAgentUpdateGoalInput,
  ProjectAgentUpdateTaskInput,
  ProjectAgentWriteDocumentInput,
  ProjectDocumentRevision,
  ProjectGoal,
  ProjectId,
  ProjectTask,
  ProjectThreadIndexEntry,
  ThreadId,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { ProjectAgentServiceError } from "../Errors.ts";
import type { ProjectAgentPrincipal } from "../principal.ts";

export interface ProjectAgentServiceShape {
  readonly getOverview: (
    input: ProjectAgentGetOverviewInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentOverview, ProjectAgentServiceError>;
  readonly configure: (
    input: ProjectAgentConfigureInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentOverview, ProjectAgentServiceError>;
  readonly startGoal: (
    input: ProjectAgentStartGoalInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectGoal, ProjectAgentServiceError>;
  readonly updateGoal: (
    input: ProjectAgentUpdateGoalInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectGoal, ProjectAgentServiceError>;
  readonly pauseGoal: (
    input: ProjectAgentGoalControlInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectGoal, ProjectAgentServiceError>;
  readonly resumeGoal: (
    input: ProjectAgentGoalControlInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectGoal, ProjectAgentServiceError>;
  readonly stopGoal: (
    input: ProjectAgentGoalControlInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectGoal, ProjectAgentServiceError>;
  readonly listTasks: (
    input: ProjectAgentListTasksInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentListTasksResult, ProjectAgentServiceError>;
  readonly createTask: (
    input: ProjectAgentCreateTaskInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectTask, ProjectAgentServiceError>;
  readonly updateTask: (
    input: ProjectAgentUpdateTaskInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectTask, ProjectAgentServiceError>;
  readonly listActivity: (
    input: ProjectAgentListActivityInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentListActivityResult, ProjectAgentServiceError>;
  readonly listDocuments: (
    input: ProjectAgentListDocumentsInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentListDocumentsResult, ProjectAgentServiceError>;
  readonly readDocument: (
    input: ProjectAgentReadDocumentInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentReadDocumentResult, ProjectAgentServiceError>;
  readonly writeDocument: (
    input: ProjectAgentWriteDocumentInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectDocumentRevision, ProjectAgentServiceError>;
  readonly exportDocuments: (
    input: ProjectAgentExportDocumentsInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentExportDocumentsResult, ProjectAgentServiceError>;
  readonly refreshDigest: (
    input: ProjectAgentRefreshDigestInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentOverview, ProjectAgentServiceError>;
  readonly scheduleDigest: (projectId: ProjectId) => Effect.Effect<void, never>;
  readonly listEvidence: (
    input: ProjectAgentListEvidenceInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentListEvidenceResult, ProjectAgentServiceError>;
  readonly listThreadIndex: (
    input: ProjectAgentListThreadIndexInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentListThreadIndexResult, ProjectAgentServiceError>;
  readonly excludeThread: (
    input: ProjectAgentExcludeThreadInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectThreadIndexEntry, ProjectAgentServiceError>;
  readonly backfillSummaries: (
    input: ProjectAgentBackfillInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentOverview, ProjectAgentServiceError>;
  readonly formatContextPacketForTurn: (
    threadId: ThreadId,
  ) => Effect.Effect<string, ProjectAgentServiceError>;
  readonly authorizeManagedGoalCreation: (input: {
    readonly callerThreadId: ThreadId;
    readonly requestedCount: number;
  }) => Effect.Effect<void, ProjectAgentServiceError>;
  readonly recordManagedWorkerThreads: (input: {
    readonly callerThreadId: ThreadId;
    readonly requestId: string;
    readonly threadIds: ReadonlyArray<ThreadId>;
    readonly titles: ReadonlyArray<string>;
  }) => Effect.Effect<void, ProjectAgentServiceError>;
  readonly reconcilePendingWakes: () => Effect.Effect<void, ProjectAgentServiceError>;
  readonly reportResult: (
    input: ProjectAgentReportResultInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectActivity, ProjectAgentServiceError>;
  readonly buildContextPacket: (
    projectId: ProjectId,
    threadId: ThreadId,
  ) => Effect.Effect<ProjectAgentContextPacket, ProjectAgentServiceError>;
  readonly ingestSettledThreadEvent: (input: {
    readonly threadId: ThreadId;
    readonly sourceEventId: string;
    readonly eventType: string;
    readonly createdAt: string;
  }) => Effect.Effect<void, ProjectAgentServiceError>;
  readonly processPendingWakes: (
    projectId: ProjectId,
  ) => Effect.Effect<void, ProjectAgentServiceError>;
  readonly resolvePrincipalForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectAgentPrincipal, ProjectAgentServiceError>;
  readonly assertCallerMayDriveManagedThread: (input: {
    readonly callerThreadId: ThreadId;
    readonly targetThreadId: ThreadId;
  }) => Effect.Effect<void, ProjectAgentServiceError>;
  readonly onProjectDeleted: (
    projectId: ProjectId,
  ) => Effect.Effect<void, ProjectAgentServiceError>;
  readonly streamEvents: (
    input: ProjectAgentSubscribeInput,
  ) => Stream.Stream<ProjectAgentStreamEvent, ProjectAgentServiceError>;
}

export class ProjectAgentService extends ServiceMap.Service<
  ProjectAgentService,
  ProjectAgentServiceShape
>()("synara/projectAgent/Services/ProjectAgentService") {}
