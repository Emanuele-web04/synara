import {
  ApprovalRequestId,
  type ChatAttachment,
  EventId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import {
  type ProjectionPendingApprovalRepositoryShape,
  ProjectionPendingApprovalRepository,
} from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import {
  type ProjectionThreadActivity,
  type ProjectionThreadActivityRepositoryShape,
  ProjectionThreadActivityRepository,
} from "../../persistence/Services/ProjectionThreadActivities.ts";
import {
  type ProjectionThreadMessage,
  type ProjectionThreadMessageRepositoryShape,
  ProjectionThreadMessageRepository,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  type ProjectionThreadProposedPlan,
  type ProjectionThreadProposedPlanRepositoryShape,
  ProjectionThreadProposedPlanRepository,
} from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import {
  type ProjectionTurn,
  ProjectionTurnRepository,
} from "../../persistence/Services/ProjectionTurns.ts";
import {
  type ProjectionThread,
  ProjectionThreadRepository,
} from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ServerConfig } from "../../config.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import {
  applyProjectMetadataProjection,
  advanceProjectMetadataSnapshotState,
  PROJECT_METADATA_SNAPSHOT_PROJECTORS,
} from "../projectMetadataProjection.ts";
import {
  attachmentRelativePath,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";
import { deriveThreadSummaryState } from "@t3tools/shared/threadSummary";

export const ORCHESTRATION_PROJECTOR_NAMES = {
  projects: "projection.projects",
  threads: "projection.threads",
  threadShellSummaries: "projection.thread-shell-summaries",
  threadMessages: "projection.thread-messages",
  threadProposedPlans: "projection.thread-proposed-plans",
  threadActivities: "projection.thread-activities",
  threadSessions: "projection.thread-sessions",
  threadTurns: "projection.thread-turns",
  checkpoints: "projection.checkpoints",
  pendingApprovals: "projection.pending-approvals",
} as const;

type ProjectorName =
  (typeof ORCHESTRATION_PROJECTOR_NAMES)[keyof typeof ORCHESTRATION_PROJECTOR_NAMES];

interface ProjectorDefinition {
  readonly name: ProjectorName;
  readonly phase: "hot" | "deferred";
  readonly shouldApply?: (event: OrchestrationEvent) => boolean;
  readonly apply: (
    event: OrchestrationEvent,
    attachmentSideEffects: AttachmentSideEffects,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

interface AttachmentSideEffects {
  readonly deletedThreadIds: Set<string>;
  readonly prunedThreadRelativePaths: Map<string, Set<string>>;
}

const REQUIRED_SNAPSHOT_PROJECTORS = PROJECT_METADATA_SNAPSHOT_PROJECTORS;
const THREAD_SHELL_SUMMARY_ACTIVITY_KINDS = new Set([
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
  "user-input.requested",
  "user-input.resolved",
  "provider.user-input.respond.failed",
]);

const materializeAttachmentsForProjection = Effect.fn(
  (input: { readonly attachments: ReadonlyArray<ChatAttachment> }) =>
    Effect.succeed(input.attachments.length === 0 ? [] : input.attachments),
);

function finalizeTurnStateFromSessionStatus(
  status: "starting" | "running" | "ready" | "interrupted" | "stopped" | "error",
  existingState: ProjectionTurn["state"],
): ProjectionTurn["state"] {
  switch (status) {
    case "error":
      return "error";
    case "interrupted":
      return "interrupted";
    case "ready":
    case "stopped":
      return existingState === "error"
        ? "error"
        : existingState === "interrupted"
          ? "interrupted"
          : "completed";
    case "starting":
    case "running":
      return "running";
  }
}

function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.makeUnsafe(requestId) : null;
}

function isStalePendingApprovalFailure(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const detail = (payload as Record<string, unknown>).detail;
  if (typeof detail !== "string") {
    return false;
  }
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request")
  );
}

function shouldRefreshThreadShellSummary(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.message-sent":
      return event.payload.role === "user";
    case "thread.proposed-plan-upserted":
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
    case "thread.reverted":
    case "thread.conversation-rolled-back":
    case "thread.session-set":
    case "thread.turn-diff-completed":
      return true;
    case "thread.activity-appended":
      return THREAD_SHELL_SUMMARY_ACTIVITY_KINDS.has(event.payload.activity.kind);
    default:
      return false;
  }
}

// Recompute the denormalized sidebar shell summary after per-thread timeline changes.
const withRefreshedThreadShellSummary = Effect.fn(function* (input: {
  readonly thread: ProjectionThread;
  readonly projectionThreadMessageRepository: ProjectionThreadMessageRepositoryShape;
  readonly projectionThreadActivityRepository: ProjectionThreadActivityRepositoryShape;
  readonly projectionThreadProposedPlanRepository: ProjectionThreadProposedPlanRepositoryShape;
  readonly projectionPendingApprovalRepository: ProjectionPendingApprovalRepositoryShape;
  readonly summaryUserInputResponseRequestId?: string;
  readonly summaryUserInputResponseCreatedAt?: string;
}) {
  const [messages, activities, proposedPlans, pendingApprovals] = yield* Effect.all([
    input.projectionThreadMessageRepository.listByThreadId({
      threadId: input.thread.threadId,
    }),
    input.projectionThreadActivityRepository.listByThreadId({
      threadId: input.thread.threadId,
    }),
    input.projectionThreadProposedPlanRepository.listByThreadId({
      threadId: input.thread.threadId,
    }),
    input.projectionPendingApprovalRepository.listByThreadId({
      threadId: input.thread.threadId,
    }),
  ]);
  const summary = deriveThreadSummaryState({
    messages,
    activities: [
      ...activities.map((activity) => ({
        id: activity.activityId,
        kind: activity.kind,
        payload: activity.payload,
        sequence: activity.sequence,
        createdAt: activity.createdAt,
      })),
      ...(input.summaryUserInputResponseRequestId
        ? [
            {
              id: EventId.makeUnsafe(
                `synthetic-user-input-resolved:${input.summaryUserInputResponseRequestId}:${input.summaryUserInputResponseCreatedAt ?? input.thread.updatedAt}`,
              ),
              kind: "user-input.resolved" as const,
              payload: {
                requestId: input.summaryUserInputResponseRequestId,
              },
              createdAt: input.summaryUserInputResponseCreatedAt ?? input.thread.updatedAt,
            },
          ]
        : []),
    ],
    proposedPlans: proposedPlans.map((plan) => ({
      id: plan.planId,
      turnId: plan.turnId,
      updatedAt: plan.updatedAt,
      implementedAt: plan.implementedAt,
    })),
    latestTurn: input.thread.latestTurnId ? { turnId: input.thread.latestTurnId } : null,
  });
  const requestedApprovalIds = new Set(
    activities
      .filter((activity) => activity.kind === "approval.requested")
      .map((activity) => extractActivityRequestId(activity.payload))
      .filter((requestId): requestId is ApprovalRequestId => requestId !== null),
  );
  const pendingApprovalCount = pendingApprovals.filter(
    (approval) => approval.status === "pending" && requestedApprovalIds.has(approval.requestId),
  ).length;

  return {
    ...input.thread,
    latestUserMessageAt: summary.latestUserMessageAt,
    pendingApprovalCount,
    pendingUserInputCount: summary.pendingUserInputCount,
    hasActionableProposedPlan: summary.hasActionableProposedPlan ? 1 : 0,
  } satisfies ProjectionThread;
});

function retainProjectionMessagesAfterRevert(
  messages: ReadonlyArray<ProjectionThreadMessage>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadMessage> {
  const retainedMessageIds = new Set<string>();
  const retainedTurnIds = new Set<string>();
  const keptTurns = turns.filter(
    (turn) =>
      turn.turnId !== null &&
      turn.checkpointTurnCount !== null &&
      turn.checkpointTurnCount <= turnCount,
  );
  for (const turn of keptTurns) {
    if (turn.turnId !== null) {
      retainedTurnIds.add(turn.turnId);
    }
    if (turn.pendingMessageId !== null) {
      retainedMessageIds.add(turn.pendingMessageId);
    }
    if (turn.assistantMessageId !== null) {
      retainedMessageIds.add(turn.assistantMessageId);
    }
  }

  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.messageId);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.messageId));
}

function retainProjectionActivitiesAfterRevert(
  activities: ReadonlyArray<ProjectionThreadActivity>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadActivity> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainProjectionProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadProposedPlan> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function rollbackProjectionMessagesFromMessage(
  messages: ReadonlyArray<ProjectionThreadMessage>,
  messageId: string,
): {
  readonly keptRows: ReadonlyArray<ProjectionThreadMessage>;
  readonly removedTurnIds: ReadonlySet<string>;
  readonly changed: boolean;
} {
  const targetIndex = messages.findIndex((message) => message.messageId === messageId);
  if (targetIndex < 0) {
    return { keptRows: messages, removedTurnIds: new Set(), changed: false };
  }
  const removedRows = messages.slice(targetIndex);
  return {
    keptRows: messages.slice(0, targetIndex),
    removedTurnIds: new Set(
      removedRows.flatMap((message) => (message.turnId === null ? [] : [message.turnId])),
    ),
    changed: true,
  };
}

function retainProjectionTurnsAfterConversationRollback(
  turns: ReadonlyArray<ProjectionTurn>,
  removedTurnIds: ReadonlySet<string>,
): ReadonlyArray<ProjectionTurn> {
  if (removedTurnIds.size === 0) {
    return turns;
  }
  return turns.filter((turn) => turn.turnId === null || !removedTurnIds.has(turn.turnId));
}

function retainProjectionActivitiesAfterConversationRollback(
  activities: ReadonlyArray<ProjectionThreadActivity>,
  removedTurnIds: ReadonlySet<string>,
): ReadonlyArray<ProjectionThreadActivity> {
  return activities.filter(
    (activity) => activity.turnId === null || !removedTurnIds.has(activity.turnId),
  );
}

function retainProjectionProposedPlansAfterConversationRollback(
  proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>,
  removedTurnIds: ReadonlySet<string>,
): ReadonlyArray<ProjectionThreadProposedPlan> {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || !removedTurnIds.has(proposedPlan.turnId),
  );
}

function collectThreadAttachmentRelativePaths(
  threadId: string,
  messages: ReadonlyArray<ProjectionThreadMessage>,
): Set<string> {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return new Set();
  }
  const relativePaths = new Set<string>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type !== "image") {
        continue;
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachment.id);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        continue;
      }
      relativePaths.add(attachmentRelativePath(attachment));
    }
  }
  return relativePaths;
}

const runAttachmentSideEffects = Effect.fn(function* (sideEffects: AttachmentSideEffects) {
  const serverConfig = yield* Effect.service(ServerConfig);
  const fileSystem = yield* Effect.service(FileSystem.FileSystem);
  const path = yield* Effect.service(Path.Path);

  const attachmentsRootDir = serverConfig.attachmentsDir;
  const attachmentRootEntries = yield* fileSystem
    .readDirectory(attachmentsRootDir, { recursive: false })
    .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));

  // Deleted-thread cleanup removes every attachment owned by the thread.
  const removeDeletedThreadAttachmentEntry = Effect.fn(function* (
    threadSegment: string,
    entry: string,
  ) {
    const normalizedEntry = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
    if (normalizedEntry.length === 0 || normalizedEntry.includes("/")) {
      return;
    }
    const attachmentId = parseAttachmentIdFromRelativePath(normalizedEntry);
    if (!attachmentId) {
      return;
    }
    const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
      return;
    }
    yield* fileSystem.remove(path.join(attachmentsRootDir, normalizedEntry), {
      force: true,
    });
  });

  const deleteThreadAttachments = Effect.fn(function* (threadId: string) {
    const threadSegment = toSafeThreadAttachmentSegment(threadId);
    if (!threadSegment) {
      yield* Effect.logWarning("skipping attachment cleanup for unsafe thread id", {
        threadId,
      });
      return;
    }

    yield* Effect.forEach(
      attachmentRootEntries,
      (entry) => removeDeletedThreadAttachmentEntry(threadSegment, entry),
      {
        concurrency: 1,
      },
    );
  });

  const pruneThreadAttachmentEntry = Effect.fn(function* (
    threadSegment: string,
    keptThreadRelativePaths: Set<string>,
    entry: string,
  ) {
    const relativePath = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
    if (relativePath.length === 0 || relativePath.includes("/")) {
      return;
    }
    const attachmentId = parseAttachmentIdFromRelativePath(relativePath);
    if (!attachmentId) {
      return;
    }
    const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
      return;
    }

    const absolutePath = path.join(attachmentsRootDir, relativePath);
    const fileInfo = yield* fileSystem
      .stat(absolutePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return;
    }

    if (!keptThreadRelativePaths.has(relativePath)) {
      yield* fileSystem.remove(absolutePath, { force: true });
    }
  });

  yield* Effect.forEach(
    sideEffects.deletedThreadIds,
    (threadId) => deleteThreadAttachments(threadId),
    { concurrency: 1 },
  );

  yield* Effect.forEach(
    sideEffects.prunedThreadRelativePaths.entries(),
    ([threadId, keptThreadRelativePaths]) => {
      if (sideEffects.deletedThreadIds.has(threadId)) {
        return Effect.void;
      }
      return Effect.gen(function* () {
        const threadSegment = toSafeThreadAttachmentSegment(threadId);
        if (!threadSegment) {
          yield* Effect.logWarning("skipping attachment prune for unsafe thread id", { threadId });
          return;
        }
        yield* Effect.forEach(
          attachmentRootEntries,
          (entry) => pruneThreadAttachmentEntry(threadSegment, keptThreadRelativePaths, entry),
          { concurrency: 1 },
        );
      });
    },
    { concurrency: 1 },
  );
});

const makeOrchestrationProjectionPipeline = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const projectionStateRepository = yield* ProjectionStateRepository;
  const projectionProjectRepository = yield* ProjectionProjectRepository;
  const projectionThreadRepository = yield* ProjectionThreadRepository;
  const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
  const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository;
  const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
  const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;

  const applyProjectsProjection: ProjectorDefinition["apply"] = (event, _attachmentSideEffects) =>
    event.type === "project.created" ||
    event.type === "project.meta-updated" ||
    event.type === "project.deleted"
      ? applyProjectMetadataProjection({
          event,
          projectionProjectRepository,
        }).pipe(Effect.asVoid)
      : Effect.void;

  const applyThreadsProjection: ProjectorDefinition["apply"] = (event, attachmentSideEffects) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.created":
          yield* projectionThreadRepository.upsert({
            threadId: event.payload.threadId,
            projectId: event.payload.projectId,
            title: event.payload.title,
            modelSelection: event.payload.modelSelection,
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
            envMode: event.payload.envMode ?? "local",
            branch: event.payload.branch,
            worktreePath: event.payload.worktreePath,
            associatedWorktreePath: event.payload.associatedWorktreePath ?? null,
            associatedWorktreeBranch: event.payload.associatedWorktreeBranch ?? null,
            associatedWorktreeRef: event.payload.associatedWorktreeRef ?? null,
            createBranchFlowCompleted: event.payload.createBranchFlowCompleted ?? false,
            parentThreadId: event.payload.parentThreadId ?? null,
            subagentAgentId: event.payload.subagentAgentId ?? null,
            subagentNickname: event.payload.subagentNickname ?? null,
            subagentRole: event.payload.subagentRole ?? null,
            forkSourceThreadId: event.payload.forkSourceThreadId,
            lastKnownPr: event.payload.lastKnownPr ?? null,
            latestTurnId: null,
            handoff: event.payload.handoff,
            latestUserMessageAt: null,
            pendingApprovalCount: 0,
            pendingUserInputCount: 0,
            hasActionableProposedPlan: 0,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            archivedAt: null,
            deletedAt: null,
          });
          return;

        case "thread.meta-updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const nextCreateBranchFlowCompleted =
            event.payload.createBranchFlowCompleted !== undefined
              ? event.payload.createBranchFlowCompleted
              : event.payload.branch !== undefined &&
                  event.payload.branch !== existingRow.value.branch
                ? false
                : undefined;
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.modelSelection !== undefined
              ? { modelSelection: event.payload.modelSelection }
              : {}),
            ...(event.payload.envMode !== undefined ? { envMode: event.payload.envMode } : {}),
            ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
            ...(event.payload.worktreePath !== undefined
              ? { worktreePath: event.payload.worktreePath }
              : {}),
            ...(event.payload.associatedWorktreePath !== undefined
              ? { associatedWorktreePath: event.payload.associatedWorktreePath }
              : {}),
            ...(event.payload.associatedWorktreeBranch !== undefined
              ? { associatedWorktreeBranch: event.payload.associatedWorktreeBranch }
              : {}),
            ...(event.payload.associatedWorktreeRef !== undefined
              ? { associatedWorktreeRef: event.payload.associatedWorktreeRef }
              : {}),
            ...(nextCreateBranchFlowCompleted !== undefined
              ? { createBranchFlowCompleted: nextCreateBranchFlowCompleted }
              : {}),
            ...(event.payload.parentThreadId !== undefined
              ? { parentThreadId: event.payload.parentThreadId }
              : {}),
            ...(event.payload.subagentAgentId !== undefined
              ? { subagentAgentId: event.payload.subagentAgentId }
              : {}),
            ...(event.payload.subagentNickname !== undefined
              ? { subagentNickname: event.payload.subagentNickname }
              : {}),
            ...(event.payload.subagentRole !== undefined
              ? { subagentRole: event.payload.subagentRole }
              : {}),
            ...(event.payload.lastKnownPr !== undefined
              ? { lastKnownPr: event.payload.lastKnownPr }
              : {}),
            ...(event.payload.handoff !== undefined ? { handoff: event.payload.handoff } : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.runtime-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            runtimeMode: event.payload.runtimeMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.interaction-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            interactionMode: event.payload.interactionMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.deleted": {
          attachmentSideEffects.deletedThreadIds.add(event.payload.threadId);
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        case "thread.archived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const archivedAt =
            event.payload.archivedAt ?? event.payload.updatedAt ?? event.occurredAt;
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt,
            updatedAt: event.payload.updatedAt ?? archivedAt,
          });
          return;
        }

        case "thread.unarchived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: null,
            updatedAt: event.payload.updatedAt ?? event.payload.unarchivedAt ?? event.occurredAt,
          });
          return;
        }

        default:
          return;
      }
    });

  // Keep denormalized shell summary work out of the live transcript projector path.
  const applyThreadShellSummariesProjection: ProjectorDefinition["apply"] = (event) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.message-sent":
        case "thread.proposed-plan-upserted":
        case "thread.activity-appended":
        case "thread.approval-response-requested":
        case "thread.user-input-response-requested":
        case "thread.reverted":
        case "thread.conversation-rolled-back": {
          if (!shouldRefreshThreadShellSummary(event)) {
            return;
          }
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const nextRow = yield* withRefreshedThreadShellSummary({
            thread: {
              ...existingRow.value,
              updatedAt: event.occurredAt,
              latestTurnId:
                event.type === "thread.reverted" || event.type === "thread.conversation-rolled-back"
                  ? null
                  : existingRow.value.latestTurnId,
            },
            projectionThreadMessageRepository,
            projectionThreadActivityRepository,
            projectionThreadProposedPlanRepository,
            projectionPendingApprovalRepository,
            ...(event.type === "thread.user-input-response-requested"
              ? {
                  summaryUserInputResponseRequestId: event.payload.requestId,
                  summaryUserInputResponseCreatedAt: event.payload.createdAt,
                }
              : {}),
          });
          yield* projectionThreadRepository.upsert(nextRow);
          return;
        }

        case "thread.session-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const nextRow = yield* withRefreshedThreadShellSummary({
            thread: {
              ...existingRow.value,
              latestTurnId: event.payload.session.activeTurnId,
              updatedAt: event.occurredAt,
            },
            projectionThreadMessageRepository,
            projectionThreadActivityRepository,
            projectionThreadProposedPlanRepository,
            projectionPendingApprovalRepository,
          });
          yield* projectionThreadRepository.upsert(nextRow);
          return;
        }

        case "thread.turn-diff-completed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const nextRow = yield* withRefreshedThreadShellSummary({
            thread: {
              ...existingRow.value,
              latestTurnId: event.payload.turnId,
              updatedAt: event.occurredAt,
            },
            projectionThreadMessageRepository,
            projectionThreadActivityRepository,
            projectionThreadProposedPlanRepository,
            projectionPendingApprovalRepository,
          });
          yield* projectionThreadRepository.upsert(nextRow);
          return;
        }

        default:
          return;
      }
    });

  const applyThreadMessagesProjection: ProjectorDefinition["apply"] = (
    event,
    attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.message-sent": {
          const existingMessage = yield* projectionThreadMessageRepository.getByMessageId({
            messageId: event.payload.messageId,
          });
          const nextText =
            Option.isSome(existingMessage) && event.payload.streaming
              ? `${existingMessage.value.text}${event.payload.text}`
              : Option.isSome(existingMessage) && event.payload.text.length === 0
                ? existingMessage.value.text
                : event.payload.text;
          const nextAttachments =
            event.payload.attachments !== undefined
              ? yield* materializeAttachmentsForProjection({
                  attachments: event.payload.attachments,
                })
              : Option.isSome(existingMessage)
                ? existingMessage.value.attachments
                : undefined;
          yield* projectionThreadMessageRepository.upsert({
            messageId: event.payload.messageId,
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            role: event.payload.role,
            text: nextText,
            ...(nextAttachments !== undefined ? { attachments: [...nextAttachments] } : {}),
            ...(event.payload.skills !== undefined ? { skills: event.payload.skills } : {}),
            ...(event.payload.mentions !== undefined ? { mentions: event.payload.mentions } : {}),
            ...(event.payload.dispatchMode !== undefined
              ? { dispatchMode: event.payload.dispatchMode }
              : {}),
            isStreaming: event.payload.streaming,
            source: event.payload.source,
            createdAt:
              (Option.isSome(existingMessage) ? existingMessage.value.createdAt : null) ??
              event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.reverted": {
          const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionMessagesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadMessageRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadMessageRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          attachmentSideEffects.prunedThreadRelativePaths.set(
            event.payload.threadId,
            collectThreadAttachmentRelativePaths(event.payload.threadId, keptRows),
          );
          return;
        }

        case "thread.conversation-rolled-back": {
          if (event.payload.numTurns === 0) {
            return;
          }
          const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const rollback = rollbackProjectionMessagesFromMessage(
            existingRows,
            event.payload.messageId,
          );
          if (!rollback.changed) {
            return;
          }

          yield* projectionThreadMessageRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(rollback.keptRows, projectionThreadMessageRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          if (event.payload.skipAttachmentPrune !== true) {
            attachmentSideEffects.prunedThreadRelativePaths.set(
              event.payload.threadId,
              collectThreadAttachmentRelativePaths(event.payload.threadId, rollback.keptRows),
            );
          }
          return;
        }

        default:
          return;
      }
    });

  const applyThreadProposedPlansProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.proposed-plan-upserted":
          yield* projectionThreadProposedPlanRepository.upsert({
            planId: event.payload.proposedPlan.id,
            threadId: event.payload.threadId,
            turnId: event.payload.proposedPlan.turnId,
            planMarkdown: event.payload.proposedPlan.planMarkdown,
            implementedAt: event.payload.proposedPlan.implementedAt,
            implementationThreadId: event.payload.proposedPlan.implementationThreadId,
            createdAt: event.payload.proposedPlan.createdAt,
            updatedAt: event.payload.proposedPlan.updatedAt,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadProposedPlanRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionProposedPlansAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadProposedPlanRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadProposedPlanRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        case "thread.conversation-rolled-back": {
          const existingRows = yield* projectionThreadProposedPlanRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }
          const removedTurnIds = new Set(event.payload.removedTurnIds ?? []);
          const keptRows = retainProjectionProposedPlansAfterConversationRollback(
            existingRows,
            removedTurnIds,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }
          yield* projectionThreadProposedPlanRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadProposedPlanRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

  const applyThreadActivitiesProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.activity-appended":
          yield* projectionThreadActivityRepository.upsert({
            activityId: event.payload.activity.id,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            tone: event.payload.activity.tone,
            kind: event.payload.activity.kind,
            summary: event.payload.activity.summary,
            payload: event.payload.activity.payload,
            ...(event.payload.activity.sequence !== undefined
              ? { sequence: event.payload.activity.sequence }
              : {}),
            createdAt: event.payload.activity.createdAt,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionActivitiesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }
          yield* projectionThreadActivityRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadActivityRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        case "thread.conversation-rolled-back": {
          const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }
          const removedTurnIds = new Set(event.payload.removedTurnIds ?? []);
          const keptRows = retainProjectionActivitiesAfterConversationRollback(
            existingRows,
            removedTurnIds,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }
          yield* projectionThreadActivityRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadActivityRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

  const applyThreadSessionsProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      if (event.type !== "thread.session-set") {
        return;
      }
      yield* projectionThreadSessionRepository.upsert({
        threadId: event.payload.threadId,
        status: event.payload.session.status,
        providerName: event.payload.session.providerName,
        runtimeMode: event.payload.session.runtimeMode,
        activeTurnId: event.payload.session.activeTurnId,
        lastError: event.payload.session.lastError,
        updatedAt: event.payload.session.updatedAt,
      });
    });

  const applyThreadTurnsProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.turn-start-requested": {
          yield* projectionTurnRepository.replacePendingTurnStart({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            sourceProposedPlanThreadId: event.payload.sourceProposedPlan?.threadId ?? null,
            sourceProposedPlanId: event.payload.sourceProposedPlan?.planId ?? null,
            requestedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.session-set": {
          const turnId = event.payload.session.activeTurnId;
          if (event.payload.session.status !== "running" || turnId === null) {
            if (
              event.payload.session.activeTurnId === null &&
              (event.payload.session.status === "ready" ||
                event.payload.session.status === "error" ||
                event.payload.session.status === "interrupted" ||
                event.payload.session.status === "stopped")
            ) {
              // Close the newest still-open turn when the runtime reports that
              // the thread is no longer running. Assistant message completion
              // can happen multiple times inside one turn, so session status is
              // the safer lifecycle boundary for `completedAt`.
              const turnToFinalize = (yield* projectionTurnRepository.listByThreadId({
                threadId: event.payload.threadId,
              }))
                .filter(
                  (
                    row,
                  ): row is ProjectionTurn & {
                    turnId: Exclude<ProjectionTurn["turnId"], null>;
                  } => row.turnId !== null && row.completedAt === null,
                )
                .toSorted(
                  (left, right) =>
                    right.requestedAt.localeCompare(left.requestedAt) ||
                    right.turnId.localeCompare(left.turnId),
                )
                .at(0);

              if (turnToFinalize) {
                yield* projectionTurnRepository.upsertByTurnId({
                  ...turnToFinalize,
                  state: finalizeTurnStateFromSessionStatus(
                    event.payload.session.status,
                    turnToFinalize.state,
                  ),
                  startedAt: turnToFinalize.startedAt ?? event.payload.session.updatedAt,
                  requestedAt: turnToFinalize.requestedAt ?? event.payload.session.updatedAt,
                  completedAt: event.payload.session.updatedAt,
                });
              }
            }
            return;
          }

          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId,
          });
          const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          if (Option.isSome(existingTurn)) {
            const nextState =
              existingTurn.value.state === "completed" || existingTurn.value.state === "error"
                ? existingTurn.value.state
                : "running";
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: nextState,
              pendingMessageId:
                existingTurn.value.pendingMessageId ??
                (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.messageId : null),
              sourceProposedPlanThreadId:
                existingTurn.value.sourceProposedPlanThreadId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanThreadId
                  : null),
              sourceProposedPlanId:
                existingTurn.value.sourceProposedPlanId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanId
                  : null),
              startedAt:
                existingTurn.value.startedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
              requestedAt:
                existingTurn.value.requestedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
            });
          } else {
            yield* projectionTurnRepository.upsertByTurnId({
              turnId,
              threadId: event.payload.threadId,
              pendingMessageId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.messageId
                : null,
              sourceProposedPlanThreadId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanThreadId
                : null,
              sourceProposedPlanId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanId
                : null,
              assistantMessageId: null,
              state: "running",
              requestedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              startedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              completedAt: null,
              checkpointTurnCount: null,
              checkpointRef: null,
              checkpointStatus: null,
              checkpointFiles: [],
            });
          }

          yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          return;
        }

        case "thread.message-sent": {
          if (event.payload.turnId === null || event.payload.role !== "assistant") {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            const existingIsTerminal =
              existingTurn.value.state === "completed" ||
              existingTurn.value.state === "error" ||
              existingTurn.value.state === "interrupted";
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.messageId,
              state:
                event.payload.streaming && !existingIsTerminal
                  ? "running"
                  : existingTurn.value.state,
              completedAt:
                event.payload.streaming && !existingIsTerminal
                  ? null
                  : existingTurn.value.completedAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.messageId,
            state: "running",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: null,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-interrupt-requested": {
          // An interrupt request is only intent, not confirmation. The provider
          // can still reject it or time out, so we keep the persisted turn state
          // unchanged until a terminal runtime event arrives.
          return;
        }

        case "thread.turn-diff-completed": {
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          const isProviderDiffPlaceholder =
            event.payload.status === "missing" &&
            event.payload.checkpointRef.startsWith("provider-diff:");
          const nextState = isProviderDiffPlaceholder
            ? Option.match(existingTurn, {
                onNone: () => "running" as const,
                onSome: (turn) => turn.state,
              })
            : event.payload.status === "error"
              ? "error"
              : "completed";
          yield* projectionTurnRepository.clearCheckpointTurnConflict({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
          });

          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              // Preserve the persisted assistantMessageId when the event payload
              // is null. Placeholder turn-diff events can fire before the
              // assistant message is finalized; they must not erase a real id
              // recorded earlier by thread.message-sent.
              assistantMessageId:
                event.payload.assistantMessageId ?? existingTurn.value.assistantMessageId,
              state: nextState,
              checkpointTurnCount: event.payload.checkpointTurnCount,
              checkpointRef: event.payload.checkpointRef,
              checkpointStatus: event.payload.status,
              checkpointFiles: event.payload.files,
              startedAt: existingTurn.value.startedAt ?? event.payload.completedAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.completedAt,
              completedAt: isProviderDiffPlaceholder
                ? existingTurn.value.completedAt
                : event.payload.completedAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.assistantMessageId,
            state: nextState,
            requestedAt: event.payload.completedAt,
            startedAt: event.payload.completedAt,
            completedAt: isProviderDiffPlaceholder ? null : event.payload.completedAt,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            checkpointStatus: event.payload.status,
            checkpointFiles: event.payload.files,
          });
          return;
        }

        case "thread.reverted": {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptTurns = existingTurns.filter(
            (turn) =>
              turn.turnId !== null &&
              turn.checkpointTurnCount !== null &&
              turn.checkpointTurnCount <= event.payload.turnCount,
          );
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            keptTurns,
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                  }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          return;
        }

        case "thread.conversation-rolled-back": {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const removedTurnIds = new Set(event.payload.removedTurnIds ?? []);
          const keptTurns = retainProjectionTurnsAfterConversationRollback(
            existingTurns,
            removedTurnIds,
          );
          if (keptTurns.length === existingTurns.length) {
            return;
          }
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            keptTurns,
            (turn) =>
              turn.turnId === null
                ? turn.pendingMessageId === null ||
                  turn.state !== "pending" ||
                  turn.checkpointTurnCount !== null
                  ? Effect.void
                  : projectionTurnRepository.replacePendingTurnStart({
                      threadId: turn.threadId,
                      messageId: turn.pendingMessageId,
                      sourceProposedPlanThreadId: turn.sourceProposedPlanThreadId,
                      sourceProposedPlanId: turn.sourceProposedPlanId,
                      requestedAt: turn.requestedAt,
                    })
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                  }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

  const applyCheckpointsProjection: ProjectorDefinition["apply"] = () => Effect.void;

  const applyPendingApprovalsProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.activity-appended": {
          const activity = event.payload.activity;
          if (
            activity.kind !== "approval.requested" &&
            activity.kind !== "approval.resolved" &&
            activity.kind !== "provider.approval.respond.failed"
          ) {
            return;
          }
          const requestId =
            extractActivityRequestId(activity.payload) ??
            event.metadata.requestId ??
            null;
          if (requestId === null) {
            return;
          }
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId,
          });
          if (
            activity.kind === "approval.resolved" ||
            (activity.kind === "provider.approval.respond.failed" &&
              isStalePendingApprovalFailure(activity.payload))
          ) {
            const resolvedDecisionRaw =
              typeof activity.payload === "object" &&
              activity.payload !== null &&
              "decision" in activity.payload
                ? (activity.payload as { decision?: unknown }).decision
                : null;
            const resolvedDecision =
              resolvedDecisionRaw === "accept" ||
              resolvedDecisionRaw === "acceptForSession" ||
              resolvedDecisionRaw === "decline" ||
              resolvedDecisionRaw === "cancel"
                ? resolvedDecisionRaw
                : null;
            yield* projectionPendingApprovalRepository.upsert({
              requestId,
              threadId: Option.isSome(existingRow)
                ? existingRow.value.threadId
                : event.payload.threadId,
              turnId: Option.isSome(existingRow)
                ? existingRow.value.turnId
                : activity.turnId,
              status: "resolved",
              decision: resolvedDecision,
              createdAt: Option.isSome(existingRow)
                ? existingRow.value.createdAt
                : activity.createdAt,
              resolvedAt: activity.createdAt,
            });
            return;
          }
          if (activity.kind !== "approval.requested") {
            return;
          }
          if (Option.isSome(existingRow) && existingRow.value.status === "resolved") {
            return;
          }
          // Only approval requests belong in this table; user-input requests are
          // derived from thread activities when refreshing the shell summary.
          yield* projectionPendingApprovalRepository.upsert({
            requestId,
            threadId: event.payload.threadId,
            turnId: activity.turnId,
            status: "pending",
            decision: null,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : activity.createdAt,
            resolvedAt: null,
          });
          return;
        }

        case "thread.approval-response-requested": {
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId: event.payload.requestId,
          });
          yield* projectionPendingApprovalRepository.upsert({
            requestId: event.payload.requestId,
            threadId: Option.isSome(existingRow)
              ? existingRow.value.threadId
              : event.payload.threadId,
            turnId: Option.isSome(existingRow) ? existingRow.value.turnId : null,
            status: "resolved",
            decision: event.payload.decision,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.createdAt,
            resolvedAt: event.payload.createdAt,
          });
          return;
        }

        default:
          return;
      }
    });

  const projectors: ReadonlyArray<ProjectorDefinition> = [
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.projects,
      phase: "hot",
      apply: applyProjectsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
      phase: "hot",
      apply: applyThreadMessagesProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
      phase: "hot",
      apply: applyThreadProposedPlansProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
      phase: "hot",
      apply: applyThreadActivitiesProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
      phase: "hot",
      apply: applyThreadSessionsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
      phase: "hot",
      apply: applyThreadTurnsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
      phase: "hot",
      apply: applyCheckpointsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
      phase: "hot",
      apply: applyPendingApprovalsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threads,
      phase: "hot",
      apply: applyThreadsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadShellSummaries,
      phase: "deferred",
      shouldApply: shouldRefreshThreadShellSummary,
      apply: applyThreadShellSummariesProjection,
    },
  ];
  const projectsProjector = projectors.find(
    (projector) => projector.name === ORCHESTRATION_PROJECTOR_NAMES.projects,
  );

  // Project metadata changes only touch the project projection, so keep them
  // off the slower full-projector pass used by thread and runtime events.
  const selectProjectorsForEvent = (
    event: OrchestrationEvent,
    phase?: ProjectorDefinition["phase"],
  ): ReadonlyArray<ProjectorDefinition> => {
    const filterProjectors = (candidates: ReadonlyArray<ProjectorDefinition>) =>
      candidates.filter(
        (projector) =>
          (phase === undefined || projector.phase === phase) &&
          (projector.shouldApply?.(event) ?? true),
      );

    switch (event.type) {
      case "project.created":
      case "project.meta-updated":
      case "project.deleted":
        return projectsProjector
          ? filterProjectors([projectsProjector]).length > 0
            ? [projectsProjector]
            : []
          : filterProjectors(projectors);
      default:
        return filterProjectors(projectors);
    }
  };

  const runProjectorForEvent = (projector: ProjectorDefinition, event: OrchestrationEvent) =>
    Effect.gen(function* () {
      const attachmentSideEffects: AttachmentSideEffects = {
        deletedThreadIds: new Set<string>(),
        prunedThreadRelativePaths: new Map<string, Set<string>>(),
      };

      yield* sql.withTransaction(
        projector.apply(event, attachmentSideEffects).pipe(
          Effect.flatMap(() =>
            projectionStateRepository.upsert({
              projector: projector.name,
              lastAppliedSequence: event.sequence,
              updatedAt: event.occurredAt,
            }),
          ),
        ),
      );

      yield* runAttachmentSideEffects(attachmentSideEffects).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to apply projected attachment side-effects", {
            projector: projector.name,
            sequence: event.sequence,
            eventType: event.type,
            cause,
          }),
        ),
      );
    });

  const advanceProjectorStateToEvent = (
    projector: ProjectorDefinition,
    event: OrchestrationEvent,
  ) =>
    projectionStateRepository.upsert({
      projector: projector.name,
      lastAppliedSequence: event.sequence,
      updatedAt: event.occurredAt,
    });

  const bootstrapProjector = (projector: ProjectorDefinition) =>
    projectionStateRepository
      .getByProjector({
        projector: projector.name,
      })
      .pipe(
        Effect.flatMap((stateRow) =>
          Effect.gen(function* () {
            let pendingSkippedEvent: OrchestrationEvent | null = null;

            yield* Stream.runForEach(
              eventStore.readFromSequence(
                Option.isSome(stateRow) ? stateRow.value.lastAppliedSequence : 0,
              ),
              (event) => {
                if (!(projector.shouldApply?.(event) ?? true)) {
                  pendingSkippedEvent = event;
                  return Effect.void;
                }

                pendingSkippedEvent = null;
                return runProjectorForEvent(projector, event);
              },
            );

            // Preserve the replay cursor across trailing non-matching events without paying the
            // full projector transaction/apply cost for bootstrap no-ops.
            if (pendingSkippedEvent) {
              yield* advanceProjectorStateToEvent(projector, pendingSkippedEvent);
            }
          }),
        ),
      );

  const advanceSnapshotProjectorStates = (event: OrchestrationEvent) =>
    sql.withTransaction(
      Effect.forEach(
        REQUIRED_SNAPSHOT_PROJECTORS,
        (projector) =>
          projectionStateRepository.upsert({
            projector,
            lastAppliedSequence: event.sequence,
            updatedAt: event.occurredAt,
          }),
        { concurrency: 1 },
      ),
    );

  const projectMetadataEvent: OrchestrationProjectionPipelineShape["projectMetadataEvent"] = (
    event,
  ) =>
    applyProjectMetadataProjection({
      event,
      projectionProjectRepository,
    }).pipe(
      Effect.flatMap(() =>
        advanceProjectMetadataSnapshotState({
          event,
          projectionStateRepository,
        }),
      ),
      Effect.asVoid,
    );

  const projectEvent: OrchestrationProjectionPipelineShape["projectEvent"] = (event) =>
    Effect.forEach(
      selectProjectorsForEvent(event),
      (projector) => runProjectorForEvent(projector, event),
      {
        concurrency: 1,
      },
    ).pipe(
      Effect.flatMap(() => {
        switch (event.type) {
          case "project.created":
          case "project.meta-updated":
          case "project.deleted":
            return advanceSnapshotProjectorStates(event);
          default:
            return Effect.void;
        }
      }),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.asVoid,
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectEvent:query")(sqlError)),
      ),
    );

  const projectHotEvent: OrchestrationProjectionPipelineShape["projectHotEvent"] = (event) =>
    Effect.forEach(
      selectProjectorsForEvent(event, "hot"),
      (projector) => runProjectorForEvent(projector, event),
      {
        concurrency: 1,
      },
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.asVoid,
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectHotEvent:query")(sqlError)),
      ),
    );

  const projectDeferredEvent: OrchestrationProjectionPipelineShape["projectDeferredEvent"] = (
    event,
  ) =>
    Effect.forEach(
      selectProjectorsForEvent(event, "deferred"),
      (projector) => runProjectorForEvent(projector, event),
      {
        concurrency: 1,
      },
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.asVoid,
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(
          toPersistenceSqlError("ProjectionPipeline.projectDeferredEvent:query")(sqlError),
        ),
      ),
    );

  const bootstrap: OrchestrationProjectionPipelineShape["bootstrap"] = Effect.forEach(
    projectors,
    bootstrapProjector,
    { concurrency: 1 },
  ).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
    Effect.provideService(ServerConfig, serverConfig),
    Effect.asVoid,
    Effect.tap(() =>
      Effect.log("orchestration projection pipeline bootstrapped").pipe(
        Effect.annotateLogs({ projectors: projectors.length }),
      ),
    ),
    Effect.catchTag("SqlError", (sqlError) =>
      Effect.fail(toPersistenceSqlError("ProjectionPipeline.bootstrap:query")(sqlError)),
    ),
  );

  return {
    bootstrap,
    projectEvent,
    projectHotEvent,
    projectDeferredEvent,
    projectMetadataEvent,
  } satisfies OrchestrationProjectionPipelineShape;
});

export const OrchestrationProjectionPipelineLive = Layer.effect(
  OrchestrationProjectionPipeline,
  makeOrchestrationProjectionPipeline,
).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionPendingApprovalRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
);
