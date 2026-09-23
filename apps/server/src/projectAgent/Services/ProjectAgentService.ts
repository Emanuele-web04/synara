import type {
  ProjectActivity,
  ProjectAgentBackfillInput,
  ProjectAgentConfigureInput,
  ProjectAgentDeleteGroupResult,
  ProjectAgentForgetInput,
  ProjectAgentForgetResult,
  ProjectAgentGroupControlInput,
  ProjectAgentLibraryAddInput,
  ProjectAgentLibraryAddResult,
  ProjectAgentLibraryListInput,
  ProjectAgentLibraryListResult,
  ProjectAgentLinkProjectInput,
  ProjectAgentLinkRepositoryInput,
  ProjectAgentListThreadsInput,
  ProjectAgentListThreadsResult,
  ProjectAgentRememberInput,
  ProjectAgentRememberResult,
  ProjectAgentUnlinkProjectInput,
  ProjectAgentContextPacket,
  ProjectAgentCreateTaskInput,
  ProjectAgentExcludeThreadInput,
  ProjectAgentExportDocumentsInput,
  ProjectAgentExportDocumentsResult,
  ProjectAgentGetOverviewInput,
  ProjectAgentListSummariesInput,
  ProjectAgentListSummariesResult,
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
  readonly listSummaries: (
    input: ProjectAgentListSummariesInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentListSummariesResult, ProjectAgentServiceError>;
  readonly configure: (
    input: ProjectAgentConfigureInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentOverview, ProjectAgentServiceError>;
  readonly linkProject: (
    input: ProjectAgentLinkProjectInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentOverview, ProjectAgentServiceError>;
  readonly unlinkProject: (
    input: ProjectAgentUnlinkProjectInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentOverview, ProjectAgentServiceError>;
  readonly linkRepository: (
    input: ProjectAgentLinkRepositoryInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentOverview, ProjectAgentServiceError>;
  readonly remember: (
    input: ProjectAgentRememberInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentRememberResult, ProjectAgentServiceError>;
  readonly forget: (
    input: ProjectAgentForgetInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentForgetResult, ProjectAgentServiceError>;
  readonly libraryList: (
    input: ProjectAgentLibraryListInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentLibraryListResult, ProjectAgentServiceError>;
  readonly libraryAdd: (
    input: ProjectAgentLibraryAddInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentLibraryAddResult, ProjectAgentServiceError>;
  readonly listGroupThreads: (
    input: ProjectAgentListThreadsInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentListThreadsResult, ProjectAgentServiceError>;
  readonly pauseGroup: (
    input: ProjectAgentGroupControlInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentOverview, ProjectAgentServiceError>;
  readonly resumeGroup: (
    input: ProjectAgentGroupControlInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentOverview, ProjectAgentServiceError>;
  readonly archiveGroup: (
    input: ProjectAgentGroupControlInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentOverview, ProjectAgentServiceError>;
  readonly unarchiveGroup: (
    input: ProjectAgentGroupControlInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentOverview, ProjectAgentServiceError>;
  readonly restartCoordinator: (
    input: ProjectAgentGroupControlInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentOverview, ProjectAgentServiceError>;
  readonly deleteGroup: (
    input: ProjectAgentGroupControlInput,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<ProjectAgentDeleteGroupResult, ProjectAgentServiceError>;
  readonly assertCallerMayCreateThreadInProject: (input: {
    readonly callerThreadId: ThreadId;
    readonly targetProjectId: ProjectId;
  }) => Effect.Effect<void, ProjectAgentServiceError>;
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
  readonly inspectWorkerHealth: () => Effect.Effect<void, ProjectAgentServiceError>;
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
