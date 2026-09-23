import { Schema } from "effect";

import {
  AutomationId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectActivityId,
  ProjectDocumentRevisionId,
  ProjectEvidenceId,
  ProjectGoalId,
  ProjectId,
  ProjectInboxEventId,
  ProjectTaskAttemptId,
  ProjectTaskId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";
import { ModelSelection, ProviderStartOptions } from "./orchestration";

export const PROJECT_AGENT_DOCUMENT_MAX_BYTES = 256 * 1024;
export const PROJECT_AGENT_CONTEXT_BUDGET_CHARS = 32_000;
export const PROJECT_AGENT_LIST_PAGE_MAX = 100;
export const PROJECT_AGENT_INITIAL_SUMMARY_THREAD_COUNT = 20;
export const PROJECT_AGENT_DIGEST_DEBOUNCE_MS = 60_000;

export const DEFAULT_PROJECT_AGENT_LIMITS = {
  maxConcurrentWorkers: 8,
  maxNewWorkersPerTurn: 8,
  maxWorkerCreationsPerGoal: 40,
  maxAutomaticContinuationsPerGoal: 20,
  maxRepairRoundsPerTask: 2,
} as const;

export const ProjectAgentRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type ProjectAgentRequestId = typeof ProjectAgentRequestId.Type;

export const ProjectAgentRevision = NonNegativeInt;
export type ProjectAgentRevision = typeof ProjectAgentRevision.Type;

export const ProjectAgentLimits = Schema.Struct({
  maxConcurrentWorkers: PositiveInt,
  maxNewWorkersPerTurn: PositiveInt,
  maxWorkerCreationsPerGoal: PositiveInt,
  maxAutomaticContinuationsPerGoal: PositiveInt,
  maxRepairRoundsPerTask: PositiveInt,
});
export type ProjectAgentLimits = typeof ProjectAgentLimits.Type;

export const ProjectAgentWorkerRouting = Schema.Struct({
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  environment: Schema.optional(Schema.Literals(["local", "worktree"])),
  runtimeMode: Schema.optional(Schema.Literals(["approval-required", "full-access"])),
});
export type ProjectAgentWorkerRouting = typeof ProjectAgentWorkerRouting.Type;

// Remote URLs are handed to `git remote add` and `git push`; `ext::sh -c ...`
// executes on push and a leading `-` parses as an option, so only the safe
// transports are allowed and the anchored pattern rejects option-looking input.
export const LIBRARY_REMOTE_URL_PATTERN = /^(https|ssh):\/\/\S+$|^git@[A-Za-z0-9._-]+:\S+$/;
export const LibraryRemoteUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2_048),
  Schema.isPattern(LIBRARY_REMOTE_URL_PATTERN),
);

export const ProjectAgentConfig = Schema.Struct({
  projectId: ProjectId,
  coordinatorThreadId: ThreadId,
  coordinatorName: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  coordinatorModelSelection: ModelSelection,
  coordinatorProviderOptions: Schema.optional(ProviderStartOptions),
  workerRouting: Schema.optional(ProjectAgentWorkerRouting),
  limits: ProjectAgentLimits,
  captureEnabled: Schema.Boolean,
  enabled: Schema.Boolean,
  automationId: Schema.NullOr(AutomationId),
  revision: ProjectAgentRevision,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  disabledAt: Schema.NullOr(IsoDateTime),
  goal: Schema.optional(Schema.String.check(Schema.isMaxLength(8_000))),
  icon: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  coordinatorIcon: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  coordinatorColor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(32))),
  autoMemoryEnabled: Schema.optional(Schema.Boolean),
  linkedProjectIds: Schema.optional(Schema.Array(ProjectId)),
  libraryPath: Schema.optional(TrimmedNonEmptyString),
  libraryRemoteUrl: Schema.optional(LibraryRemoteUrl),
  libraryPushOnChange: Schema.optional(Schema.Boolean),
});
export type ProjectAgentConfig = typeof ProjectAgentConfig.Type;

export const ProjectGoalStatus = Schema.Literals([
  "draft",
  "active",
  "paused",
  "stopped",
  "completed",
  "cancelled",
]);
export type ProjectGoalStatus = typeof ProjectGoalStatus.Type;

export const ProjectGoal = Schema.Struct({
  id: ProjectGoalId,
  projectId: ProjectId,
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
  authorizationSource: Schema.Literal("user"),
  scopeVersion: PositiveInt,
  acceptanceCriteria: Schema.NullOr(Schema.String.check(Schema.isMaxLength(16_000))),
  limits: ProjectAgentLimits,
  status: ProjectGoalStatus,
  continuationCount: NonNegativeInt,
  workerCreationCount: NonNegativeInt,
  authorizedAt: IsoDateTime,
  revision: ProjectAgentRevision,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectGoal = typeof ProjectGoal.Type;

export const ProjectTaskStatus = Schema.Literals([
  "planned",
  "ready",
  "running",
  "review",
  "done",
  "blocked",
  "cancelled",
]);
export type ProjectTaskStatus = typeof ProjectTaskStatus.Type;

export const ProjectTask = Schema.Struct({
  id: ProjectTaskId,
  projectId: ProjectId,
  goalId: ProjectGoalId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  description: Schema.NullOr(Schema.String.check(Schema.isMaxLength(16_000))),
  acceptanceCriteria: Schema.NullOr(Schema.String.check(Schema.isMaxLength(16_000))),
  status: ProjectTaskStatus,
  dependsOnTaskIds: Schema.Array(ProjectTaskId),
  assignedThreadId: Schema.NullOr(ThreadId),
  repairCount: NonNegativeInt,
  archivedAt: Schema.NullOr(IsoDateTime),
  revision: ProjectAgentRevision,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectTask = typeof ProjectTask.Type;

export const ProjectTaskAttemptOutcome = Schema.Literals([
  "running",
  "succeeded",
  "failed",
  "interrupted",
]);
export type ProjectTaskAttemptOutcome = typeof ProjectTaskAttemptOutcome.Type;

export const ProjectTaskAttempt = Schema.Struct({
  id: ProjectTaskAttemptId,
  projectId: ProjectId,
  taskId: ProjectTaskId,
  workerThreadId: ThreadId,
  gatewayOperationId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  requestId: ProjectAgentRequestId,
  attemptNumber: PositiveInt,
  outcome: ProjectTaskAttemptOutcome,
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000))),
  createdAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectTaskAttempt = typeof ProjectTaskAttempt.Type;

export const ProjectEvidenceKind = Schema.Literals([
  "message",
  "document",
  "artifact",
  "test",
  "decision",
]);
export type ProjectEvidenceKind = typeof ProjectEvidenceKind.Type;

export const ProjectEvidenceClassification = Schema.Literals([
  "observed",
  "reported",
  "user-confirmed",
]);
export type ProjectEvidenceClassification = typeof ProjectEvidenceClassification.Type;

export const ProjectEvidence = Schema.Struct({
  id: ProjectEvidenceId,
  projectId: ProjectId,
  taskId: Schema.NullOr(ProjectTaskId),
  attemptId: Schema.NullOr(ProjectTaskAttemptId),
  kind: ProjectEvidenceKind,
  classification: ProjectEvidenceClassification,
  authorKind: Schema.Literals(["user", "coordinator", "worker", "system"]),
  authorThreadId: Schema.NullOr(ThreadId),
  sourceThreadId: Schema.NullOr(ThreadId),
  sourceMessageId: Schema.NullOr(MessageId),
  sourceTurnId: Schema.NullOr(TurnId),
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
  createdAt: IsoDateTime,
});
export type ProjectEvidence = typeof ProjectEvidence.Type;

export const ProjectDocumentLogicalPath = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
export type ProjectDocumentLogicalPath = typeof ProjectDocumentLogicalPath.Type;

export const ProjectDocumentSource = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  messageId: Schema.optional(MessageId),
  turnId: Schema.optional(TurnId),
  path: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
});
export type ProjectDocumentSource = typeof ProjectDocumentSource.Type;

export const ProjectDocumentRevision = Schema.Struct({
  id: ProjectDocumentRevisionId,
  projectId: ProjectId,
  logicalPath: ProjectDocumentLogicalPath,
  revision: PositiveInt,
  content: Schema.String.check(Schema.isMaxLength(PROJECT_AGENT_DOCUMENT_MAX_BYTES)),
  contentHash: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  authorKind: Schema.Literals(["user", "coordinator", "worker", "system"]),
  authorThreadId: Schema.NullOr(ThreadId),
  sources: Schema.Array(ProjectDocumentSource),
  createdAt: IsoDateTime,
});
export type ProjectDocumentRevision = typeof ProjectDocumentRevision.Type;

export const ProjectDocumentHead = Schema.Struct({
  projectId: ProjectId,
  logicalPath: ProjectDocumentLogicalPath,
  revision: PositiveInt,
  contentHash: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  diskHash: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  conflictPending: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type ProjectDocumentHead = typeof ProjectDocumentHead.Type;

export const ProjectActivityKind = Schema.Literals([
  "config-updated",
  "goal-started",
  "goal-updated",
  "goal-paused",
  "goal-resumed",
  "goal-stopped",
  "task-created",
  "task-updated",
  "task-accepted",
  "attempt-recorded",
  "document-written",
  "document-conflict",
  "digest-updated",
  "digest-failed",
  "wake-enqueued",
  "wake-skipped",
  "error",
]);
export type ProjectActivityKind = typeof ProjectActivityKind.Type;

export const ProjectActivity = Schema.Struct({
  id: ProjectActivityId,
  projectId: ProjectId,
  sequence: PositiveInt,
  kind: ProjectActivityKind,
  actorKind: Schema.Literals(["user", "coordinator", "worker", "system"]),
  actorThreadId: Schema.NullOr(ThreadId),
  goalId: Schema.NullOr(ProjectGoalId),
  taskId: Schema.NullOr(ProjectTaskId),
  source: Schema.NullOr(ProjectDocumentSource),
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  createdAt: IsoDateTime,
});
export type ProjectActivity = typeof ProjectActivity.Type;

export const ProjectDigestFocusItem = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  kind: Schema.Literals(["task", "message", "artifact", "blocker"]),
  pinned: Schema.Boolean,
  taskId: Schema.optional(ProjectTaskId),
  sourceThreadId: Schema.optional(ThreadId),
  sourceMessageId: Schema.optional(MessageId),
  artifactPath: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
});
export type ProjectDigestFocusItem = typeof ProjectDigestFocusItem.Type;

export const ProjectDigestGenerationState = Schema.Literals([
  "idle",
  "pending",
  "running",
  "failed",
]);
export type ProjectDigestGenerationState = typeof ProjectDigestGenerationState.Type;

export const ProjectDigest = Schema.Struct({
  projectId: ProjectId,
  summary: Schema.String.check(Schema.isMaxLength(8_000)),
  focusItems: Schema.Array(ProjectDigestFocusItem),
  coverageFromSequence: NonNegativeInt,
  coverageToSequence: NonNegativeInt,
  historicalCoverage: Schema.Literals(["complete", "partial", "none"]),
  summarizedThreadCount: NonNegativeInt,
  pendingThreadCount: NonNegativeInt,
  generationState: ProjectDigestGenerationState,
  generatedAt: Schema.NullOr(IsoDateTime),
  lastGoodAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
});
export type ProjectDigest = typeof ProjectDigest.Type;

export const ProjectThreadIndexEntry = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  excluded: Schema.Boolean,
  archived: Schema.Boolean,
  summaryStatus: Schema.Literals(["pending", "covered", "skipped"]),
  lastUpdatedAt: Schema.NullOr(IsoDateTime),
  lastSummarizedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectThreadIndexEntry = typeof ProjectThreadIndexEntry.Type;

export const ProjectInboxEvent = Schema.Struct({
  id: ProjectInboxEventId,
  projectId: ProjectId,
  sourceThreadId: ThreadId,
  sourceEventId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  eventType: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  taskId: Schema.NullOr(ProjectTaskId),
  eligibleWake: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type ProjectInboxEvent = typeof ProjectInboxEvent.Type;

export const ProjectAgentBlocker = Schema.Struct({
  taskId: ProjectTaskId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
});
export type ProjectAgentBlocker = typeof ProjectAgentBlocker.Type;

export const ProjectAgentOverview = Schema.Struct({
  projectId: ProjectId,
  configured: Schema.Boolean,
  config: Schema.NullOr(ProjectAgentConfig),
  goal: Schema.NullOr(ProjectGoal),
  digest: Schema.NullOr(ProjectDigest),
  blockers: Schema.Array(ProjectAgentBlocker),
  recentOutcomes: Schema.Array(ProjectActivity),
  coordinatorStatus: Schema.Literals(["unconfigured", "idle", "running", "paused", "stopped"]),
});
export type ProjectAgentOverview = typeof ProjectAgentOverview.Type;

export const ProjectAgentListPage = Schema.Struct({
  cursor: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_AGENT_LIST_PAGE_MAX)),
  ).pipe(Schema.withDecodingDefault(() => 50)),
  includeArchived: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
});
export type ProjectAgentListPage = typeof ProjectAgentListPage.Type;

export const ProjectAgentGetOverviewInput = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectAgentGetOverviewInput = typeof ProjectAgentGetOverviewInput.Type;

export const ProjectAgentSummary = Schema.Struct({
  projectId: ProjectId,
  configured: Schema.Boolean,
  coordinatorName: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  coordinatorThreadId: Schema.NullOr(ThreadId),
  coordinatorIcon: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  coordinatorColor: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(32))),
  coordinatorStatus: Schema.Literals(["unconfigured", "idle", "running", "paused", "stopped"]),
  revision: ProjectAgentRevision,
});
export type ProjectAgentSummary = typeof ProjectAgentSummary.Type;

export const ProjectAgentListSummariesInput = Schema.Struct({});
export type ProjectAgentListSummariesInput = typeof ProjectAgentListSummariesInput.Type;

export const ProjectAgentListSummariesResult = Schema.Struct({
  summaries: Schema.Array(ProjectAgentSummary),
});
export type ProjectAgentListSummariesResult = typeof ProjectAgentListSummariesResult.Type;

export const ProjectAgentConfigureInput = Schema.Struct({
  requestId: ProjectAgentRequestId,
  projectId: ProjectId,
  coordinatorName: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  coordinatorModelSelection: ModelSelection,
  coordinatorProviderOptions: Schema.optional(ProviderStartOptions),
  workerRouting: Schema.optional(ProjectAgentWorkerRouting),
  limits: Schema.optional(ProjectAgentLimits).pipe(
    Schema.withDecodingDefault(() => ({ ...DEFAULT_PROJECT_AGENT_LIMITS })),
  ),
  captureEnabled: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => true)),
  expectedRevision: Schema.optional(ProjectAgentRevision),
  importedInstructions: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_AGENT_DOCUMENT_MAX_BYTES)),
  ),
  goal: Schema.optional(Schema.String.check(Schema.isMaxLength(8_000))),
  icon: Schema.optional(Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(64)))),
  coordinatorIcon: Schema.optional(
    Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  ),
  coordinatorColor: Schema.optional(
    Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(32))),
  ),
  autoMemoryEnabled: Schema.optional(Schema.Boolean),
  userDisplayName: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  libraryPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  libraryRemoteUrl: Schema.optional(Schema.NullOr(LibraryRemoteUrl)),
  libraryPushOnChange: Schema.optional(Schema.Boolean),
});
export type ProjectAgentConfigureInput = typeof ProjectAgentConfigureInput.Type;

export const ProjectAgentLinkProjectInput = Schema.Struct({
  requestId: ProjectAgentRequestId,
  projectId: ProjectId,
  linkedProjectId: ProjectId,
});
export type ProjectAgentLinkProjectInput = typeof ProjectAgentLinkProjectInput.Type;

export const ProjectAgentUnlinkProjectInput = Schema.Struct({
  requestId: ProjectAgentRequestId,
  projectId: ProjectId,
  linkedProjectId: ProjectId,
});
export type ProjectAgentUnlinkProjectInput = typeof ProjectAgentUnlinkProjectInput.Type;

export const ProjectAgentStartGoalInput = Schema.Struct({
  requestId: ProjectAgentRequestId,
  projectId: ProjectId,
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
  acceptanceCriteria: Schema.optional(Schema.String.check(Schema.isMaxLength(16_000))),
  limits: Schema.optional(ProjectAgentLimits),
});
export type ProjectAgentStartGoalInput = typeof ProjectAgentStartGoalInput.Type;

export const ProjectAgentUpdateGoalInput = Schema.Struct({
  requestId: ProjectAgentRequestId,
  projectId: ProjectId,
  goalId: ProjectGoalId,
  expectedRevision: ProjectAgentRevision,
  objective: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(16_000))),
  acceptanceCriteria: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(16_000))),
  ),
  scopeVersion: Schema.optional(PositiveInt),
});
export type ProjectAgentUpdateGoalInput = typeof ProjectAgentUpdateGoalInput.Type;

export const ProjectAgentGoalControlInput = Schema.Struct({
  requestId: ProjectAgentRequestId,
  projectId: ProjectId,
  goalId: ProjectGoalId,
  expectedRevision: ProjectAgentRevision,
});
export type ProjectAgentGoalControlInput = typeof ProjectAgentGoalControlInput.Type;

export const ProjectAgentListTasksInput = Schema.Struct({
  projectId: ProjectId,
  goalId: Schema.optional(ProjectGoalId),
  cursor: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_AGENT_LIST_PAGE_MAX)),
  ).pipe(Schema.withDecodingDefault(() => 50)),
  includeArchived: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
});
export type ProjectAgentListTasksInput = typeof ProjectAgentListTasksInput.Type;

export const ProjectAgentListTasksResult = Schema.Struct({
  tasks: Schema.Array(ProjectTask),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type ProjectAgentListTasksResult = typeof ProjectAgentListTasksResult.Type;

export const ProjectAgentUpdateTaskInput = Schema.Struct({
  requestId: ProjectAgentRequestId,
  projectId: ProjectId,
  taskId: ProjectTaskId,
  expectedRevision: ProjectAgentRevision,
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(240))),
  description: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(16_000)))),
  acceptanceCriteria: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(16_000))),
  ),
  status: Schema.optional(ProjectTaskStatus),
  dependsOnTaskIds: Schema.optional(Schema.Array(ProjectTaskId)),
  archived: Schema.optional(Schema.Boolean),
  accept: Schema.optional(Schema.Boolean),
});
export type ProjectAgentUpdateTaskInput = typeof ProjectAgentUpdateTaskInput.Type;

export const ProjectAgentListActivityInput = Schema.Struct({
  projectId: ProjectId,
  cursor: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_AGENT_LIST_PAGE_MAX)),
  ).pipe(Schema.withDecodingDefault(() => 50)),
});
export type ProjectAgentListActivityInput = typeof ProjectAgentListActivityInput.Type;

export const ProjectAgentListActivityResult = Schema.Struct({
  activity: Schema.Array(ProjectActivity),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type ProjectAgentListActivityResult = typeof ProjectAgentListActivityResult.Type;

export const ProjectAgentListDocumentsInput = Schema.Struct({
  projectId: ProjectId,
  prefix: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
});
export type ProjectAgentListDocumentsInput = typeof ProjectAgentListDocumentsInput.Type;

export const ProjectAgentListDocumentsResult = Schema.Struct({
  documents: Schema.Array(ProjectDocumentHead),
});
export type ProjectAgentListDocumentsResult = typeof ProjectAgentListDocumentsResult.Type;

export const ProjectAgentReadDocumentInput = Schema.Struct({
  projectId: ProjectId,
  logicalPath: ProjectDocumentLogicalPath,
  revision: Schema.optional(PositiveInt),
});
export type ProjectAgentReadDocumentInput = typeof ProjectAgentReadDocumentInput.Type;

export const ProjectAgentReadDocumentResult = Schema.Struct({
  head: ProjectDocumentHead,
  document: ProjectDocumentRevision,
  history: Schema.Array(
    Schema.Struct({
      revision: PositiveInt,
      contentHash: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
      authorKind: Schema.Literals(["user", "coordinator", "worker", "system"]),
      createdAt: IsoDateTime,
    }),
  ),
});
export type ProjectAgentReadDocumentResult = typeof ProjectAgentReadDocumentResult.Type;

export const ProjectAgentWriteDocumentInput = Schema.Struct({
  requestId: ProjectAgentRequestId,
  projectId: ProjectId,
  logicalPath: ProjectDocumentLogicalPath,
  expectedRevision: Schema.optional(NonNegativeInt),
  content: Schema.String.check(Schema.isMaxLength(PROJECT_AGENT_DOCUMENT_MAX_BYTES)),
  sources: Schema.optional(Schema.Array(ProjectDocumentSource)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  importExternal: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
});
export type ProjectAgentWriteDocumentInput = typeof ProjectAgentWriteDocumentInput.Type;

export const ProjectAgentExportDocumentsInput = Schema.Struct({
  requestId: ProjectAgentRequestId,
  projectId: ProjectId,
  logicalPaths: Schema.Array(ProjectDocumentLogicalPath),
  destinationDirectory: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
});
export type ProjectAgentExportDocumentsInput = typeof ProjectAgentExportDocumentsInput.Type;

export const ProjectAgentExportDocumentsResult = Schema.Struct({
  exportedPaths: Schema.Array(TrimmedNonEmptyString),
});
export type ProjectAgentExportDocumentsResult = typeof ProjectAgentExportDocumentsResult.Type;

export const ProjectAgentRefreshDigestInput = Schema.Struct({
  requestId: ProjectAgentRequestId,
  projectId: ProjectId,
});
export type ProjectAgentRefreshDigestInput = typeof ProjectAgentRefreshDigestInput.Type;

export const ProjectAgentExcludeThreadInput = Schema.Struct({
  requestId: ProjectAgentRequestId,
  projectId: ProjectId,
  threadId: ThreadId,
  excluded: Schema.Boolean,
});
export type ProjectAgentExcludeThreadInput = typeof ProjectAgentExcludeThreadInput.Type;

export const ProjectAgentBackfillInput = Schema.Struct({
  requestId: ProjectAgentRequestId,
  projectId: ProjectId,
});
export type ProjectAgentBackfillInput = typeof ProjectAgentBackfillInput.Type;

export const ProjectAgentListThreadIndexInput = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectAgentListThreadIndexInput = typeof ProjectAgentListThreadIndexInput.Type;

export const ProjectAgentListThreadIndexResult = Schema.Struct({
  threads: Schema.Array(ProjectThreadIndexEntry),
});
export type ProjectAgentListThreadIndexResult = typeof ProjectAgentListThreadIndexResult.Type;

export const ProjectAgentListEvidenceInput = Schema.Struct({
  projectId: ProjectId,
  taskId: ProjectTaskId,
});
export type ProjectAgentListEvidenceInput = typeof ProjectAgentListEvidenceInput.Type;

export const ProjectAgentListEvidenceResult = Schema.Struct({
  evidence: Schema.Array(ProjectEvidence),
});
export type ProjectAgentListEvidenceResult = typeof ProjectAgentListEvidenceResult.Type;

export const ProjectAgentSubscribeInput = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectAgentSubscribeInput = typeof ProjectAgentSubscribeInput.Type;

export const ProjectAgentStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    overview: ProjectAgentOverview,
  }),
  Schema.Struct({
    type: Schema.Literal("config-upserted"),
    config: ProjectAgentConfig,
  }),
  Schema.Struct({
    type: Schema.Literal("goal-upserted"),
    goal: ProjectGoal,
  }),
  Schema.Struct({
    type: Schema.Literal("task-upserted"),
    task: ProjectTask,
  }),
  Schema.Struct({
    type: Schema.Literal("activity-appended"),
    activity: ProjectActivity,
  }),
  Schema.Struct({
    type: Schema.Literal("digest-upserted"),
    digest: ProjectDigest,
  }),
  Schema.Struct({
    type: Schema.Literal("document-head-updated"),
    head: ProjectDocumentHead,
  }),
]);
export type ProjectAgentStreamEvent = typeof ProjectAgentStreamEvent.Type;

export const ProjectAgentContextPacket = Schema.Struct({
  projectId: ProjectId,
  goal: Schema.NullOr(ProjectGoal),
  instructions: Schema.String,
  relevantDecisions: Schema.String,
  tasks: Schema.Array(ProjectTask),
  documentReferences: Schema.Array(ProjectDocumentLogicalPath),
  historicalCoverage: Schema.Literals(["complete", "partial", "none"]),
  characterCount: NonNegativeInt,
});
export type ProjectAgentContextPacket = typeof ProjectAgentContextPacket.Type;

export const ProjectAgentCreateTaskInput = Schema.Struct({
  requestId: ProjectAgentRequestId,
  projectId: ProjectId,
  goalId: ProjectGoalId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(16_000))),
  acceptanceCriteria: Schema.optional(Schema.String.check(Schema.isMaxLength(16_000))),
  dependsOnTaskIds: Schema.optional(Schema.Array(ProjectTaskId)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
});
export type ProjectAgentCreateTaskInput = typeof ProjectAgentCreateTaskInput.Type;

export const ProjectAgentReportResultInput = Schema.Struct({
  requestId: ProjectAgentRequestId,
  projectId: ProjectId,
  taskId: ProjectTaskId,
  attemptId: Schema.optional(ProjectTaskAttemptId),
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  evidenceKind: Schema.optional(ProjectEvidenceKind).pipe(
    Schema.withDecodingDefault(() => "message" as const),
  ),
});
export type ProjectAgentReportResultInput = typeof ProjectAgentReportResultInput.Type;

export const PROJECT_AGENT_RESERVED_PATHS = [
  "overview.md",
  "instructions.md",
  "notes.md",
  "decisions.md",
  "archived.md",
  "artifacts/index.md",
  "internal/manifest.json",
  "memory/MEMORY.md",
] as const;

export const PROJECT_AGENT_USER_WRITABLE_PATHS = ["instructions.md", "notes.md"] as const;
export const PROJECT_AGENT_COORDINATOR_CURATED_PREFIXES = ["decisions.md", "docs/"] as const;
export const PROJECT_AGENT_WORKER_INBOX_PREFIX = "inbox/";

// ----- Group Library (git-versioned file store) -----

export const LibraryEntry = Schema.Struct({
  /** File or directory name, e.g. "notes.md". */
  name: TrimmedNonEmptyString,
  /** Path relative to the library root, e.g. "Artifacts/brief.pdf". */
  relativePath: TrimmedNonEmptyString,
  kind: Schema.Literals(["file", "directory"]),
  /** 0 for directories. */
  sizeBytes: NonNegativeInt,
  modifiedAt: IsoDateTime,
});
export type LibraryEntry = typeof LibraryEntry.Type;

export const LibraryCommit = Schema.Struct({
  sha: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  at: IsoDateTime,
  author: TrimmedNonEmptyString,
});
export type LibraryCommit = typeof LibraryCommit.Type;

export const ProjectAgentLibraryListInput = Schema.Struct({
  projectId: ProjectId,
  /** Directory to list, relative to the library root. Omit for the root. */
  relativePath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectAgentLibraryListInput = typeof ProjectAgentLibraryListInput.Type;

export const ProjectAgentLibraryListResult = Schema.Struct({
  root: TrimmedNonEmptyString,
  entries: Schema.Array(LibraryEntry),
});
export type ProjectAgentLibraryListResult = typeof ProjectAgentLibraryListResult.Type;

export const ProjectAgentLibraryMkdirInput = Schema.Struct({
  projectId: ProjectId,
  relativePath: TrimmedNonEmptyString,
});
export type ProjectAgentLibraryMkdirInput = typeof ProjectAgentLibraryMkdirInput.Type;

export const ProjectAgentLibraryRenameInput = Schema.Struct({
  projectId: ProjectId,
  from: TrimmedNonEmptyString,
  to: TrimmedNonEmptyString,
});
export type ProjectAgentLibraryRenameInput = typeof ProjectAgentLibraryRenameInput.Type;

export const ProjectAgentLibraryDeleteInput = Schema.Struct({
  projectId: ProjectId,
  relativePath: TrimmedNonEmptyString,
});
export type ProjectAgentLibraryDeleteInput = typeof ProjectAgentLibraryDeleteInput.Type;

/** Commit created by a library mutation (`sha` is the previous HEAD when the
 *  mutation produced no index change). */
export const ProjectAgentLibraryMutationResult = Schema.Struct({
  commitSha: TrimmedNonEmptyString,
});
export type ProjectAgentLibraryMutationResult = typeof ProjectAgentLibraryMutationResult.Type;

export const ProjectAgentLibraryHistoryInput = Schema.Struct({
  projectId: ProjectId,
  relativePath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectAgentLibraryHistoryInput = typeof ProjectAgentLibraryHistoryInput.Type;

export const ProjectAgentLibraryHistoryResult = Schema.Struct({
  root: TrimmedNonEmptyString,
  commits: Schema.Array(LibraryCommit),
});
export type ProjectAgentLibraryHistoryResult = typeof ProjectAgentLibraryHistoryResult.Type;

export const ProjectAgentLibraryRestoreInput = Schema.Struct({
  projectId: ProjectId,
  relativePath: TrimmedNonEmptyString,
  // Full 40-hex sha only: it lands in `git checkout <sha> -- <path>` where a
  // leading dash or ref expression would become an option/attack surface.
  sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
});
export type ProjectAgentLibraryRestoreInput = typeof ProjectAgentLibraryRestoreInput.Type;

export const ProjectAgentLibraryStatusInput = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectAgentLibraryStatusInput = typeof ProjectAgentLibraryStatusInput.Type;

export const ProjectAgentLibraryStatusResult = Schema.Struct({
  root: TrimmedNonEmptyString,
  remoteConfigured: Schema.Boolean,
  lastPushAt: Schema.NullOr(IsoDateTime),
  lastPushError: Schema.NullOr(TrimmedNonEmptyString),
});
export type ProjectAgentLibraryStatusResult = typeof ProjectAgentLibraryStatusResult.Type;
