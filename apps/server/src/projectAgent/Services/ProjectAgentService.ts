import type {
  ProjectActivity,
  ProjectAgentConfigureInput,
  ProjectAgentContextPacket,
  ProjectAgentCreateTaskInput,
  ProjectAgentExportDocumentsInput,
  ProjectAgentExportDocumentsResult,
  ProjectAgentGetOverviewInput,
  ProjectAgentGoalControlInput,
  ProjectAgentListActivityInput,
  ProjectAgentListActivityResult,
  ProjectAgentListDocumentsInput,
  ProjectAgentListDocumentsResult,
  ProjectAgentListTasksInput,
  ProjectAgentListTasksResult,
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
  readonly onProjectDeleted: (projectId: ProjectId) => Effect.Effect<void, ProjectAgentServiceError>;
  readonly streamEvents: (
    input: ProjectAgentSubscribeInput,
  ) => Stream.Stream<ProjectAgentStreamEvent, ProjectAgentServiceError>;
}

export class ProjectAgentService extends ServiceMap.Service<
  ProjectAgentService,
  ProjectAgentServiceShape
>()("synara/projectAgent/Services/ProjectAgentService") {}
