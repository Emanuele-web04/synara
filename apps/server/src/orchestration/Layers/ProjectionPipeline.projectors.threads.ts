// Purpose: Thread-timeline projector closures (threads, shell summaries, messages,
//   proposed plans, activities, sessions) plus the shell-summary refresh and
//   attachment-materialization helpers they close over.
// Layer: dependency-parameterized projector closures; built via makeThreadProjectors(deps).
// Exports: makeThreadProjectors.

import {
  ApprovalRequestId,
  type ChatAttachment,
  EventId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";

import {
  type ProjectionThread,
} from "../../persistence/Services/ProjectionThreads.ts";
import { deriveThreadSummaryState } from "@t3tools/shared/threadSummary";
import type { ProjectorDefinition } from "./ProjectionPipeline.types.ts";
import type { ProjectionProjectorDeps } from "./ProjectionPipeline.projectors.ts";
import {
  collectThreadAttachmentRelativePaths,
  extractActivityRequestId,
  retainProjectionActivitiesAfterConversationRollback,
  retainProjectionActivitiesAfterRevert,
  retainProjectionMessagesAfterRevert,
  retainProjectionProposedPlansAfterConversationRollback,
  retainProjectionProposedPlansAfterRevert,
  rollbackProjectionMessagesFromMessage,
  shouldRefreshThreadShellSummary,
} from "./ProjectionPipeline.helpers.ts";

const materializeAttachmentsForProjection = Effect.fn(
  (input: { readonly attachments: ReadonlyArray<ChatAttachment> }) =>
    Effect.succeed(input.attachments.length === 0 ? [] : input.attachments),
);

export const makeThreadProjectors = (deps: ProjectionProjectorDeps) => {
  const {
    projectionThreadRepository,
    projectionThreadMessageRepository,
    projectionThreadProposedPlanRepository,
    projectionThreadActivityRepository,
    projectionThreadSessionRepository,
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

  return {
    applyThreadsProjection,
    applyThreadShellSummariesProjection,
    applyThreadMessagesProjection,
    applyThreadProposedPlansProjection,
    applyThreadActivitiesProjection,
    applyThreadSessionsProjection,
  };
};
