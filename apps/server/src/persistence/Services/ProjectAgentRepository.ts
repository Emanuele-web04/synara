import {
  ProjectActivity,
  ProjectAgentConfig,
  ProjectAgentRequestId,
  ProjectGoalStatus,
  ProjectDigest,
  ProjectDocumentHead,
  ProjectDocumentRevision,
  ProjectEvidence,
  ProjectGoal,
  ProjectGoalId,
  ProjectId,
  ProjectInboxEvent,
  ProjectTask,
  ProjectTaskAttempt,
  ProjectTaskId,
  ProjectThreadIndexEntry,
  ThreadId,
} from "@synara/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export type ProjectAgentRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export const ProjectAgentReceipt = Schema.Struct({
  requestId: ProjectAgentRequestId,
  projectId: ProjectId,
  operation: Schema.String,
  resultJson: Schema.String,
  createdAt: Schema.String,
});
export type ProjectAgentReceipt = typeof ProjectAgentReceipt.Type;

export interface ProjectAgentConfigSummaryRow {
  readonly projectId: ProjectId;
  readonly coordinatorName: ProjectAgentConfig["coordinatorName"];
  readonly coordinatorThreadId: ThreadId;
  readonly coordinatorIcon: string | null;
  readonly coordinatorColor: string | null;
  readonly revision: ProjectAgentConfig["revision"];
  readonly goalStatus: ProjectGoalStatus | null;
  /** Coordinator objective text stored on the config (`config.goal`). */
  readonly goal: string | null;
  readonly pausedAt: string | null;
  readonly archivedAt: string | null;
  /** Visible index ∪ task-assigned member threads (excludes the coordinator). */
  readonly memberThreadIds: ReadonlyArray<ThreadId>;
  readonly linkedProjectIds: ReadonlyArray<ProjectId>;
  /** Head content of instructions.md, when the document exists. */
  readonly instructionsContent: string | null;
}

export interface ProjectAgentRepositoryShape {
  readonly getConfig: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ProjectAgentConfig>, ProjectAgentRepositoryError>;
  readonly listConfigs: () => Effect.Effect<
    ReadonlyArray<ProjectAgentConfig>,
    ProjectAgentRepositoryError
  >;
  readonly listSummaries: () => Effect.Effect<
    ReadonlyArray<ProjectAgentConfigSummaryRow>,
    ProjectAgentRepositoryError
  >;
  readonly getConfigByCoordinatorThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectAgentConfig>, ProjectAgentRepositoryError>;
  readonly saveConfig: (
    config: ProjectAgentConfig,
    expectedRevision: number | null,
  ) => Effect.Effect<ProjectAgentConfig, ProjectAgentRepositoryError>;
  readonly listLinkedProjectIds: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<ProjectId>, ProjectAgentRepositoryError>;
  readonly linkProject: (input: {
    readonly projectId: ProjectId;
    readonly linkedProjectId: ProjectId;
    readonly createdAt: string;
  }) => Effect.Effect<void, ProjectAgentRepositoryError>;
  readonly unlinkProject: (input: {
    readonly projectId: ProjectId;
    readonly linkedProjectId: ProjectId;
  }) => Effect.Effect<void, ProjectAgentRepositoryError>;
  readonly getActiveGoal: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ProjectGoal>, ProjectAgentRepositoryError>;
  readonly getGoal: (
    goalId: ProjectGoalId,
  ) => Effect.Effect<Option.Option<ProjectGoal>, ProjectAgentRepositoryError>;
  readonly saveGoal: (
    goal: ProjectGoal,
    expectedRevision: number | null,
  ) => Effect.Effect<ProjectGoal, ProjectAgentRepositoryError>;
  readonly listTasks: (input: {
    readonly projectId: ProjectId;
    readonly goalId?: ProjectGoalId;
    readonly includeArchived: boolean;
    readonly limit: number;
    readonly cursor?: { readonly createdAt: string; readonly id: string };
  }) => Effect.Effect<ReadonlyArray<ProjectTask>, ProjectAgentRepositoryError>;
  readonly getTask: (
    taskId: ProjectTaskId,
  ) => Effect.Effect<Option.Option<ProjectTask>, ProjectAgentRepositoryError>;
  readonly saveTask: (
    task: ProjectTask,
    expectedRevision: number | null,
  ) => Effect.Effect<ProjectTask, ProjectAgentRepositoryError>;
  readonly listTaskEdges: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyMap<ProjectTaskId, ReadonlyArray<ProjectTaskId>>,
    ProjectAgentRepositoryError
  >;
  readonly saveAttempt: (
    attempt: ProjectTaskAttempt,
  ) => Effect.Effect<ProjectTaskAttempt, ProjectAgentRepositoryError>;
  readonly getAttemptByRequestId: (
    requestId: string,
  ) => Effect.Effect<Option.Option<ProjectTaskAttempt>, ProjectAgentRepositoryError>;
  readonly listAttemptsForTask: (
    taskId: ProjectTaskId,
  ) => Effect.Effect<ReadonlyArray<ProjectTaskAttempt>, ProjectAgentRepositoryError>;
  readonly saveEvidence: (
    evidence: ProjectEvidence,
  ) => Effect.Effect<ProjectEvidence, ProjectAgentRepositoryError>;
  readonly listEvidenceForTask: (
    taskId: ProjectTaskId,
  ) => Effect.Effect<ReadonlyArray<ProjectEvidence>, ProjectAgentRepositoryError>;
  readonly getDocumentHead: (
    projectId: ProjectId,
    logicalPath: string,
  ) => Effect.Effect<Option.Option<ProjectDocumentHead>, ProjectAgentRepositoryError>;
  readonly listDocumentHeads: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<ProjectDocumentHead>, ProjectAgentRepositoryError>;
  readonly readDocumentRevision: (input: {
    readonly projectId: ProjectId;
    readonly logicalPath: string;
    readonly revision?: number;
  }) => Effect.Effect<Option.Option<ProjectDocumentRevision>, ProjectAgentRepositoryError>;
  readonly listDocumentHistory: (input: {
    readonly projectId: ProjectId;
    readonly logicalPath: string;
  }) => Effect.Effect<
    ReadonlyArray<
      Pick<ProjectDocumentRevision, "revision" | "contentHash" | "authorKind" | "createdAt">
    >,
    ProjectAgentRepositoryError
  >;
  readonly writeDocument: (input: {
    readonly revision: ProjectDocumentRevision;
    readonly expectedRevision: number | null;
    readonly diskHash?: string | null;
    readonly conflictPending?: boolean;
  }) => Effect.Effect<ProjectDocumentRevision, ProjectAgentRepositoryError>;
  /** Update only the head row's disk-sync marker after the mirror write lands. */
  readonly markDocumentDiskSynced: (input: {
    readonly projectId: ProjectId;
    readonly logicalPath: string;
    readonly diskHash: string;
  }) => Effect.Effect<void, ProjectAgentRepositoryError>;
  /** Remove one document entirely: revisions plus its head row. */
  readonly deleteDocument: (input: {
    readonly projectId: ProjectId;
    readonly logicalPath: string;
  }) => Effect.Effect<void, ProjectAgentRepositoryError>;
  /** Remove every project-agent row for a project (config, goals, tasks,
   *  evidence, documents, activity, digests, inbox, cursors, index, receipts).
   *  Used when a group is deleted; the orchestration project.delete command
   *  still runs afterwards for the projection layer. */
  readonly deleteProjectData: (
    projectId: ProjectId,
  ) => Effect.Effect<void, ProjectAgentRepositoryError>;
  readonly readDocumentRevisions: (input: {
    readonly projectId: ProjectId;
    readonly logicalPaths: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<ProjectDocumentRevision>, ProjectAgentRepositoryError>;
  readonly appendActivity: (
    activity: Omit<ProjectActivity, "sequence">,
  ) => Effect.Effect<ProjectActivity, ProjectAgentRepositoryError>;
  readonly listActivity: (input: {
    readonly projectId: ProjectId;
    readonly limit: number;
    readonly cursor?: {
      readonly sequence?: number;
      readonly createdAt?: string;
      readonly id?: string;
    };
  }) => Effect.Effect<ReadonlyArray<ProjectActivity>, ProjectAgentRepositoryError>;
  readonly resetInterruptedDigests: () => Effect.Effect<number, ProjectAgentRepositoryError>;
  readonly getDigest: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ProjectDigest>, ProjectAgentRepositoryError>;
  readonly saveDigest: (
    digest: ProjectDigest,
  ) => Effect.Effect<ProjectDigest, ProjectAgentRepositoryError>;
  readonly upsertThreadIndex: (
    entry: ProjectThreadIndexEntry,
  ) => Effect.Effect<void, ProjectAgentRepositoryError>;
  readonly listThreadIndex: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<ProjectThreadIndexEntry>, ProjectAgentRepositoryError>;
  readonly insertInboxEvent: (
    event: ProjectInboxEvent,
  ) => Effect.Effect<
    { readonly inserted: boolean; readonly event: ProjectInboxEvent },
    ProjectAgentRepositoryError
  >;
  readonly listInboxAfter: (input: {
    readonly projectId: ProjectId;
    readonly afterCreatedAt?: string | null;
    readonly afterId?: string | null;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ProjectInboxEvent>, ProjectAgentRepositoryError>;
  readonly getInboxEvent: (input: {
    readonly projectId: ProjectId;
    readonly inboxId: string;
  }) => Effect.Effect<Option.Option<ProjectInboxEvent>, ProjectAgentRepositoryError>;
  readonly getCursor: (projectId: ProjectId) => Effect.Effect<
    {
      readonly processedThroughInboxId: string | null;
      readonly processedThroughCreatedAt: string | null;
      readonly frozenFromInboxId: string | null;
      readonly frozenToInboxId: string | null;
      readonly coordinatorBusy: boolean;
      readonly coordinatorBusySince: string | null;
    },
    ProjectAgentRepositoryError
  >;
  readonly saveCursor: (input: {
    readonly projectId: ProjectId;
    readonly processedThroughInboxId: string | null;
    readonly processedThroughCreatedAt: string | null;
    readonly frozenFromInboxId: string | null;
    readonly frozenToInboxId: string | null;
    readonly coordinatorBusy: boolean;
    readonly coordinatorBusySince: string | null;
    readonly updatedAt: string;
  }) => Effect.Effect<void, ProjectAgentRepositoryError>;
  readonly getReceipt: (input: {
    readonly requestId: string;
    readonly projectId: ProjectId;
  }) => Effect.Effect<Option.Option<ProjectAgentReceipt>, ProjectAgentRepositoryError>;
  readonly saveReceipt: (
    receipt: ProjectAgentReceipt,
  ) => Effect.Effect<void, ProjectAgentRepositoryError>;
  readonly countRunningWorkers: (
    projectId: ProjectId,
  ) => Effect.Effect<number, ProjectAgentRepositoryError>;
  readonly findTaskByAssignedThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectTask>, ProjectAgentRepositoryError>;
}

export class ProjectAgentRepository extends ServiceMap.Service<
  ProjectAgentRepository,
  ProjectAgentRepositoryShape
>()("synara/persistence/Services/ProjectAgentRepository") {}
