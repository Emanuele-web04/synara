// Purpose: The eleven orchestration projector `apply` closures plus the shell-summary
//   refresh and attachment-materialization helpers they close over.
// Layer: dependency-parameterized projector closures; built once per pipeline via makeProjectionProjectors(deps).
// Exports: ProjectionProjectorDeps, ProjectionProjectors, makeProjectionProjectors.

import {
  ApprovalRequestId,
  type ChatAttachment,
  EventId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";

import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepository } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import {
  type ProjectionThreadRuntime,
  ProjectionThreadRuntimeRepository,
} from "../../persistence/Services/ProjectionThreadRuntime.ts";
import {
  type ProjectionTurn,
  ProjectionTurnRepository,
} from "../../persistence/Services/ProjectionTurns.ts";
import {
  type ProjectionThread,
  ProjectionThreadRepository,
} from "../../persistence/Services/ProjectionThreads.ts";
import { applyProjectMetadataProjection } from "../projectMetadataProjection.ts";
import { deriveThreadSummaryState } from "@t3tools/shared/threadSummary";
import type { ProjectorDefinition } from "./ProjectionPipeline.types.ts";
import {
  clampRuntimeTail,
  collectThreadAttachmentRelativePaths,
  emptyRuntimeReadModel,
  extractActivityRequestId,
  finalizeTurnStateFromSessionStatus,
  isStalePendingApprovalFailure,
  retainProjectionActivitiesAfterConversationRollback,
  retainProjectionActivitiesAfterRevert,
  retainProjectionMessagesAfterRevert,
  retainProjectionProposedPlansAfterConversationRollback,
  retainProjectionProposedPlansAfterRevert,
  retainProjectionTurnsAfterConversationRollback,
  rollbackProjectionMessagesFromMessage,
  shouldRefreshThreadShellSummary,
  upsertById,
} from "./ProjectionPipeline.helpers.ts";

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

const materializeAttachmentsForProjection = Effect.fn(
  (input: { readonly attachments: ReadonlyArray<ChatAttachment> }) =>
    Effect.succeed(input.attachments.length === 0 ? [] : input.attachments),
);

export const makeProjectionProjectors = (deps: ProjectionProjectorDeps) => {
  const {
    projectionProjectRepository,
    projectionThreadRepository,
    projectionThreadMessageRepository,
    projectionThreadProposedPlanRepository,
    projectionThreadActivityRepository,
    projectionThreadSessionRepository,
    projectionThreadRuntimeRepository,
    projectionTurnRepository,
    projectionPendingApprovalRepository,
  } = deps;

  // Recompute the denormalized sidebar shell summary after per-thread timeline changes.
  const withRefreshedThreadShellSummary = Effect.fn(function* (input: {
    readonly thread: ProjectionThread;
    readonly summaryUserInputResponseRequestId?: string;
    readonly summaryUserInputResponseCreatedAt?: string;
  }) {
    const [messages, activities, proposedPlans, pendingApprovals] = yield* Effect.all([
      projectionThreadMessageRepository.listByThreadId({
        threadId: input.thread.threadId,
      }),
      projectionThreadActivityRepository.listByThreadId({
        threadId: input.thread.threadId,
      }),
      projectionThreadProposedPlanRepository.listByThreadId({
        threadId: input.thread.threadId,
      }),
      projectionPendingApprovalRepository.listByThreadId({
        threadId: input.thread.threadId,
      }),
    ]);
    const summary = deriveThreadSummaryState({
      messages,
      activities: [
        ...activities.map((activity) => ({
          id: activity.activityId,
          kind: activity.kind,
          payload: activity.payload as OrchestrationThreadActivity["payload"],
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
            isPinned: event.payload.isPinned ?? false,
            parentThreadId: event.payload.parentThreadId ?? null,
            subagentAgentId: event.payload.subagentAgentId ?? null,
            subagentNickname: event.payload.subagentNickname ?? null,
            subagentRole: event.payload.subagentRole ?? null,
            forkSourceThreadId: event.payload.forkSourceThreadId,
            sidechatSourceThreadId: event.payload.sidechatSourceThreadId,
            lastKnownPr: event.payload.lastKnownPr ?? null,
            reviewChatTarget: event.payload.reviewChatTarget ?? null,
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
            ...(event.payload.isPinned !== undefined ? { isPinned: event.payload.isPinned } : {}),
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
            ...(event.payload.reviewChatTarget !== undefined
              ? { reviewChatTarget: event.payload.reviewChatTarget }
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

        case "thread.turn-start-requested": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const [messages, session] = yield* Effect.all([
            projectionThreadMessageRepository.listByThreadId({
              threadId: event.payload.threadId,
            }),
            projectionThreadSessionRepository.getByThreadId({
              threadId: event.payload.threadId,
            }),
          ]);
          const canAdoptFirstTurnProvider =
            existingRow.value.latestTurnId === null &&
            Option.isNone(session) &&
            messages.length <= 1;
          const modelSelectionPatch =
            event.payload.modelSelection !== undefined &&
            (event.payload.modelSelection.provider === existingRow.value.modelSelection.provider ||
              canAdoptFirstTurnProvider)
              ? { modelSelection: event.payload.modelSelection }
              : {};
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...modelSelectionPatch,
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
            updatedAt: event.payload.createdAt,
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
                existingTurn.value.startedAt ?? event.payload.session.updatedAt ?? event.occurredAt,
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
              // Keep `startedAt` tied to provider runtime start, not the earlier user dispatch.
              startedAt: event.payload.session.updatedAt ?? event.occurredAt,
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
            extractActivityRequestId(activity.payload) ?? event.metadata.requestId ?? null;
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
              turnId: Option.isSome(existingRow) ? existingRow.value.turnId : activity.turnId,
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

  const loadRuntimeReadModel = (threadId: ProjectionThreadRuntime["threadId"]) =>
    projectionThreadRuntimeRepository
      .getReadModelByThreadId({ threadId })
      .pipe(Effect.map((option) => (Option.isSome(option) ? option.value : null)));

  const applyThreadRuntimeProjection: ProjectorDefinition["apply"] = (event, _side) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.runtime-provision-requested": {
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          const next: ProjectionThreadRuntime = existing
            ? {
                ...existing,
                targetKind: event.payload.targetKind,
                provider: event.payload.provider,
                role: event.payload.role,
                status: "provisioning",
                updatedAt: event.payload.requestedAt,
              }
            : emptyRuntimeReadModel({
                threadId: event.payload.threadId,
                targetKind: event.payload.targetKind,
                provider: event.payload.provider,
                role: event.payload.role,
                status: "provisioning",
                updatedAt: event.payload.requestedAt,
              });
          yield* projectionThreadRuntimeRepository.upsertReadModel(next);
          return;
        }

        case "thread.runtime-instance-created": {
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          const instance = {
            id: event.payload.instanceId,
            provider: event.payload.provider,
            status: event.payload.status,
            rootPath: event.payload.rootPath,
            failureReason: null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.createdAt,
          };
          yield* projectionThreadRuntimeRepository.upsertInstance({
            instanceId: event.payload.instanceId,
            threadId: event.payload.threadId,
            provider: event.payload.provider,
            status: event.payload.status,
            rootPath: event.payload.rootPath,
            failureReason: null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.createdAt,
          });
          const base =
            existing ??
            emptyRuntimeReadModel({
              threadId: event.payload.threadId,
              targetKind: "remote-runtime",
              provider: event.payload.provider,
              role: "agent",
              status: event.payload.status,
              updatedAt: event.payload.createdAt,
            });
          yield* projectionThreadRuntimeRepository.upsertReadModel({
            ...base,
            provider: event.payload.provider,
            runtimeInstanceId: event.payload.instanceId,
            status: event.payload.status,
            rootPath: event.payload.rootPath,
            instance,
            updatedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.runtime-instance-state-changed": {
          yield* projectionThreadRuntimeRepository.upsertInstance({
            instanceId: event.payload.instanceId,
            threadId: event.payload.threadId,
            provider: (yield* loadRuntimeReadModel(event.payload.threadId))?.provider ?? "local",
            status: event.payload.status,
            rootPath: event.payload.rootPath ?? null,
            failureReason: event.payload.failureReason ?? null,
            createdAt: event.payload.updatedAt,
            updatedAt: event.payload.updatedAt,
          });
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          if (existing === null) {
            return;
          }
          yield* projectionThreadRuntimeRepository.upsertReadModel({
            ...existing,
            status: event.payload.status,
            rootPath: event.payload.rootPath ?? existing.rootPath,
            instance:
              existing.instance !== null && existing.instance.id === event.payload.instanceId
                ? {
                    ...existing.instance,
                    status: event.payload.status,
                    rootPath: event.payload.rootPath ?? existing.instance.rootPath,
                    failureReason: event.payload.failureReason ?? null,
                    updatedAt: event.payload.updatedAt,
                  }
                : existing.instance,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.runtime-process-started": {
          yield* projectionThreadRuntimeRepository.upsertProcess({
            processId: event.payload.processId,
            instanceId: event.payload.instanceId,
            threadId: event.payload.threadId,
            role: event.payload.role,
            command: event.payload.command,
            status: "running",
            exitCode: null,
            failureReason: null,
            tail: null,
            startedAt: event.payload.startedAt,
            exitedAt: null,
          });
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          if (existing === null) {
            return;
          }
          yield* projectionThreadRuntimeRepository.upsertReadModel({
            ...existing,
            processes: upsertById(existing.processes, {
              id: event.payload.processId,
              role: event.payload.role,
              command: event.payload.command,
              status: "running",
              exitCode: null,
              failureReason: null,
              startedAt: event.payload.startedAt,
              exitedAt: null,
            }),
            lastActivityAt: event.payload.startedAt,
            updatedAt: event.payload.startedAt,
          });
          return;
        }

        case "thread.runtime-process-output": {
          // Stream-only: keep `lastActivityAt` fresh and stash a bounded tail on
          // the operational process row. Never persist a row per output line.
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          if (existing === null) {
            return;
          }
          yield* projectionThreadRuntimeRepository.upsertReadModel({
            ...existing,
            lastActivityAt: event.payload.occurredAt,
            updatedAt: event.payload.occurredAt,
          });
          return;
        }

        case "thread.runtime-process-completed": {
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          yield* projectionThreadRuntimeRepository.upsertProcess({
            processId: event.payload.processId,
            instanceId: event.payload.instanceId,
            threadId: event.payload.threadId,
            role:
              existing?.processes.find((process) => process.id === event.payload.processId)?.role ??
              "exec",
            command:
              existing?.processes.find((process) => process.id === event.payload.processId)
                ?.command ?? null,
            status: event.payload.status,
            exitCode: event.payload.exitCode,
            failureReason: event.payload.failureReason ?? null,
            tail:
              event.payload.tail === undefined || event.payload.tail === null
                ? null
                : clampRuntimeTail(event.payload.tail),
            startedAt:
              existing?.processes.find((process) => process.id === event.payload.processId)
                ?.startedAt ?? event.payload.exitedAt,
            exitedAt: event.payload.exitedAt,
          });
          if (existing === null) {
            return;
          }
          const previousProcess = existing.processes.find(
            (process) => process.id === event.payload.processId,
          );
          yield* projectionThreadRuntimeRepository.upsertReadModel({
            ...existing,
            processes: upsertById(existing.processes, {
              id: event.payload.processId,
              role: previousProcess?.role ?? "exec",
              command: previousProcess?.command ?? null,
              status: event.payload.status,
              exitCode: event.payload.exitCode,
              failureReason: event.payload.failureReason,
              startedAt: previousProcess?.startedAt ?? event.payload.exitedAt,
              exitedAt: event.payload.exitedAt,
            }),
            lastActivityAt: event.payload.exitedAt,
            updatedAt: event.payload.exitedAt,
          });
          return;
        }

        case "thread.runtime-route-exposed": {
          yield* projectionThreadRuntimeRepository.upsertRoute({
            routeId: event.payload.routeId,
            instanceId: event.payload.instanceId,
            threadId: event.payload.threadId,
            port: event.payload.port,
            url: event.payload.url,
            label: event.payload.label ?? null,
            exposedAt: event.payload.exposedAt,
          });
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          if (existing === null) {
            return;
          }
          yield* projectionThreadRuntimeRepository.upsertReadModel({
            ...existing,
            routes: upsertById(existing.routes, {
              id: event.payload.routeId,
              port: event.payload.port,
              url: event.payload.url,
              label: event.payload.label,
              exposedAt: event.payload.exposedAt,
            }),
            updatedAt: event.payload.exposedAt,
          });
          return;
        }

        case "thread.runtime-snapshot-created": {
          yield* projectionThreadRuntimeRepository.upsertSnapshot({
            snapshotId: event.payload.snapshotId,
            instanceId: event.payload.instanceId,
            threadId: event.payload.threadId,
            label: event.payload.label ?? null,
            secretTainted: event.payload.secretTainted ?? false,
            createdAt: event.payload.createdAt,
          });
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          if (existing === null) {
            return;
          }
          yield* projectionThreadRuntimeRepository.upsertReadModel({
            ...existing,
            snapshots: upsertById(existing.snapshots, {
              id: event.payload.snapshotId,
              label: event.payload.label,
              secretTainted: event.payload.secretTainted,
              createdAt: event.payload.createdAt,
            }),
            updatedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.runtime-lease-renewed": {
          yield* projectionThreadRuntimeRepository.upsertLease({
            leaseId: event.payload.leaseId,
            instanceId: event.payload.instanceId,
            threadId: event.payload.threadId,
            reason: event.payload.reason,
            acquiredAt: event.payload.acquiredAt,
            renewedAt: event.payload.renewedAt ?? null,
            expiresAt: event.payload.expiresAt ?? null,
            releasedAt: event.payload.released ? (event.payload.renewedAt ?? null) : null,
          });
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          if (existing === null) {
            return;
          }
          const activeLease = {
            id: event.payload.leaseId,
            reason: event.payload.reason,
            acquiredAt: event.payload.acquiredAt,
            renewedAt: event.payload.renewedAt,
            expiresAt: event.payload.expiresAt,
          };
          yield* projectionThreadRuntimeRepository.upsertReadModel({
            ...existing,
            leases: event.payload.released
              ? existing.leases.filter((lease) => lease.id !== event.payload.leaseId)
              : upsertById(existing.leases, activeLease),
            lastActivityAt: event.payload.renewedAt ?? existing.lastActivityAt,
            updatedAt: event.payload.renewedAt ?? event.payload.acquiredAt,
          });
          return;
        }

        case "thread.runtime-destroyed": {
          yield* projectionThreadRuntimeRepository.upsertInstance({
            instanceId: event.payload.instanceId,
            threadId: event.payload.threadId,
            provider: (yield* loadRuntimeReadModel(event.payload.threadId))?.provider ?? "local",
            status: "destroyed",
            rootPath: null,
            failureReason: null,
            createdAt: event.payload.destroyedAt,
            updatedAt: event.payload.destroyedAt,
          });
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          if (existing === null) {
            return;
          }
          yield* projectionThreadRuntimeRepository.upsertReadModel({
            ...existing,
            status: "destroyed",
            instance:
              existing.instance !== null
                ? {
                    ...existing.instance,
                    status: "destroyed",
                    updatedAt: event.payload.destroyedAt,
                  }
                : existing.instance,
            leases: [],
            updatedAt: event.payload.destroyedAt,
          });
          return;
        }

        case "thread.runtime-failed": {
          if (event.payload.instanceId !== null) {
            yield* projectionThreadRuntimeRepository.upsertInstance({
              instanceId: event.payload.instanceId,
              threadId: event.payload.threadId,
              provider: (yield* loadRuntimeReadModel(event.payload.threadId))?.provider ?? "local",
              status: "failed",
              rootPath: null,
              failureReason: event.payload.failureReason,
              createdAt: event.payload.occurredAt,
              updatedAt: event.payload.occurredAt,
            });
          }
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          if (existing === null) {
            return;
          }
          yield* projectionThreadRuntimeRepository.upsertReadModel({
            ...existing,
            status: "failed",
            instance:
              existing.instance !== null
                ? {
                    ...existing.instance,
                    status: "failed",
                    failureReason: event.payload.failureReason,
                    updatedAt: event.payload.occurredAt,
                  }
                : existing.instance,
            updatedAt: event.payload.occurredAt,
          });
          return;
        }

        default:
          return;
      }
    });

  return {
    applyProjectsProjection,
    applyThreadsProjection,
    applyThreadShellSummariesProjection,
    applyThreadMessagesProjection,
    applyThreadProposedPlansProjection,
    applyThreadActivitiesProjection,
    applyThreadSessionsProjection,
    applyThreadTurnsProjection,
    applyCheckpointsProjection,
    applyPendingApprovalsProjection,
    applyThreadRuntimeProjection,
  };
};
