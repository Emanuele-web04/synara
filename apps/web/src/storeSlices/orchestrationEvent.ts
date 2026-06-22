// FILE: storeSlices/orchestrationEvent.ts
// Purpose: Reduce a single orchestration domain event into the next AppState.
// Layer: Pure dispatcher; thread mutations route through an injected applyThreadUpdate so the
//   store keeps ownership of projection/commit while this module stays free of store imports.
// Exports: applyOrchestrationEvent, ApplyThreadUpdate (injected reducer type).

import { EventId, type OrchestrationEvent, type ThreadId } from "@t3tools/contracts";
import { resolveThreadBranchRegressionGuard } from "@t3tools/shared/git";
import type { AppState } from "../store";
import { type Thread } from "../types";
import { arraysShallowEqual, deepEqualJson, normalizeModelSelection } from "./equality";
import { resolveCreateBranchFlowCompletedMerge } from "./threadMerge";
import { normalizeThreadErrorMessage, normalizeThreadSession } from "./threadNormalization";
import {
  applyThreadMessageSentEvent,
  applyTurnDiffSummaryToThread,
  buildLatestTurn,
  checkpointStatusToLatestTurnState,
  reconcileLatestTurnFromSession,
  retainThreadActivitiesAfterRevert,
  retainThreadMessagesAfterRevert,
  retainThreadProposedPlansAfterRevert,
  rollbackThreadMessagesFromMessage,
} from "./threadTurns";
import { upsertProjectFromReadModel } from "./projects";
import { normalizeProposedPlans } from "./threadProposedPlans";
import {
  resolveThreadSummaryAfterApprovalResponseRequested,
  resolveThreadSummaryAfterUserInputResponseRequested,
} from "./sidebarSummaries";
import { THREAD_SUMMARY_ACTIVITY_KINDS, normalizeActivities } from "./threadActivities";
import { MAX_THREAD_MESSAGES } from "./threadMessages";
import { removeThreadState } from "./threadProjection";

type ThreadMessageSentEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;
type ThreadActivityAppendedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.activity-appended" }
>;

function newerThreadUpdatedAt(
  thread: Pick<Thread, "createdAt" | "updatedAt">,
  updatedAt: string,
): string {
  return (thread.updatedAt ?? thread.createdAt) > updatedAt
    ? (thread.updatedAt ?? thread.createdAt)
    : updatedAt;
}

export type ApplyThreadUpdate = (
  state: AppState,
  threadId: ThreadId,
  updater: (thread: Thread) => Thread,
  options?: {
    updateThreadArray?: boolean;
    recomputeSummarySignals?: boolean;
    updateSidebarSummary?: boolean;
  },
) => AppState;

function threadMessageUpdatesSummary(event: ThreadMessageSentEvent): boolean {
  return event.payload.role === "user";
}

function threadActivityUpdatesSummary(event: ThreadActivityAppendedEvent): boolean {
  return THREAD_SUMMARY_ACTIVITY_KINDS.has(event.payload.activity.kind);
}

// Sidebar summaries can follow turn boundaries, but not every streaming assistant delta.
function threadMessageUpdatesSidebarSummary(event: ThreadMessageSentEvent): boolean {
  return event.payload.role === "user" || !event.payload.streaming;
}

export function applyOrchestrationEvent(
  applyThreadUpdate: ApplyThreadUpdate,
  state: AppState,
  event: OrchestrationEvent,
  options?: {
    updateThreadArray?: boolean;
    updateSidebarSummary?: boolean;
  },
): AppState {
  switch (event.type) {
    case "project.created":
      return upsertProjectFromReadModel(state, {
        id: event.payload.projectId,
        kind: event.payload.kind,
        title: event.payload.title,
        workspaceRoot: event.payload.workspaceRoot,
        defaultModelSelection: event.payload.defaultModelSelection,
        scripts: event.payload.scripts,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
        deletedAt: null,
      });

    case "project.meta-updated": {
      const existingProject = state.projects.find(
        (project) => project.id === event.payload.projectId,
      );
      if (!existingProject) {
        return state;
      }
      return upsertProjectFromReadModel(state, {
        id: existingProject.id,
        kind: event.payload.kind ?? existingProject.kind,
        title: event.payload.title ?? existingProject.remoteName,
        workspaceRoot: event.payload.workspaceRoot ?? existingProject.cwd,
        defaultModelSelection:
          event.payload.defaultModelSelection !== undefined
            ? event.payload.defaultModelSelection
            : existingProject.defaultModelSelection,
        scripts: event.payload.scripts ?? existingProject.scripts,
        createdAt: existingProject.createdAt ?? event.payload.updatedAt,
        updatedAt: event.payload.updatedAt,
        deletedAt: null,
      });
    }

    case "project.deleted": {
      const existingIndex = state.projects.findIndex(
        (project) => project.id === event.payload.projectId,
      );
      if (existingIndex < 0) {
        return state;
      }
      return {
        ...state,
        projects: state.projects.filter((project) => project.id !== event.payload.projectId),
      };
    }

    case "thread.meta-updated":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const modelSelection =
            event.payload.modelSelection !== undefined
              ? normalizeModelSelection(event.payload.modelSelection, thread.modelSelection)
              : thread.modelSelection;
          const nextBranch =
            event.payload.branch !== undefined
              ? resolveThreadBranchRegressionGuard({
                  currentBranch: thread.branch,
                  nextBranch: event.payload.branch,
                })
              : thread.branch;
          const nextWorktreePath =
            event.payload.worktreePath !== undefined
              ? event.payload.worktreePath
              : thread.worktreePath;
          const nextAssociatedWorktreePath =
            event.payload.associatedWorktreePath !== undefined
              ? event.payload.associatedWorktreePath
              : (thread.associatedWorktreePath ?? null);
          const nextAssociatedWorktreeBranch =
            event.payload.associatedWorktreeBranch !== undefined
              ? event.payload.associatedWorktreeBranch
              : (thread.associatedWorktreeBranch ?? null);
          const nextAssociatedWorktreeRef =
            event.payload.associatedWorktreeRef !== undefined
              ? event.payload.associatedWorktreeRef
              : (thread.associatedWorktreeRef ?? null);
          const nextCreateBranchFlowCompleted = resolveCreateBranchFlowCompletedMerge({
            currentBranch: thread.branch,
            nextBranch,
            currentWorktreePath: thread.worktreePath,
            nextWorktreePath,
            currentAssociatedWorktreePath: thread.associatedWorktreePath,
            nextAssociatedWorktreePath,
            currentAssociatedWorktreeBranch: thread.associatedWorktreeBranch,
            nextAssociatedWorktreeBranch,
            currentAssociatedWorktreeRef: thread.associatedWorktreeRef,
            nextAssociatedWorktreeRef,
            currentCreateBranchFlowCompleted: thread.createBranchFlowCompleted,
            nextCreateBranchFlowCompleted: event.payload.createBranchFlowCompleted,
          });
          const nextUpdatedAt = newerThreadUpdatedAt(thread, event.payload.updatedAt);
          const cwdChanged = thread.worktreePath !== nextWorktreePath;

          if (
            (event.payload.title === undefined || event.payload.title === thread.title) &&
            modelSelection === thread.modelSelection &&
            (event.payload.envMode === undefined || event.payload.envMode === thread.envMode) &&
            nextBranch === thread.branch &&
            nextWorktreePath === thread.worktreePath &&
            nextAssociatedWorktreePath === (thread.associatedWorktreePath ?? null) &&
            nextAssociatedWorktreeBranch === (thread.associatedWorktreeBranch ?? null) &&
            nextAssociatedWorktreeRef === (thread.associatedWorktreeRef ?? null) &&
            nextCreateBranchFlowCompleted === (thread.createBranchFlowCompleted ?? false) &&
            (event.payload.isPinned === undefined ||
              event.payload.isPinned === (thread.isPinned ?? false)) &&
            (event.payload.pinnedMessages === undefined ||
              deepEqualJson(event.payload.pinnedMessages, thread.pinnedMessages ?? null)) &&
            (event.payload.threadMarkers === undefined ||
              deepEqualJson(event.payload.threadMarkers, thread.threadMarkers ?? null)) &&
            (event.payload.notes === undefined || event.payload.notes === thread.notes) &&
            (event.payload.parentThreadId === undefined ||
              (event.payload.parentThreadId ?? null) === (thread.parentThreadId ?? null)) &&
            (event.payload.subagentAgentId === undefined ||
              (event.payload.subagentAgentId ?? null) === (thread.subagentAgentId ?? null)) &&
            (event.payload.subagentNickname === undefined ||
              (event.payload.subagentNickname ?? null) === (thread.subagentNickname ?? null)) &&
            (event.payload.subagentRole === undefined ||
              (event.payload.subagentRole ?? null) === (thread.subagentRole ?? null)) &&
            (event.payload.lastKnownPr === undefined ||
              deepEqualJson(event.payload.lastKnownPr ?? null, thread.lastKnownPr ?? null)) &&
            (event.payload.reviewChatTarget === undefined ||
              deepEqualJson(
                event.payload.reviewChatTarget ?? null,
                thread.reviewChatTarget ?? null,
              )) &&
            (event.payload.handoff === undefined ||
              (event.payload.handoff ?? null) === (thread.handoff ?? null)) &&
            nextUpdatedAt === thread.updatedAt
          ) {
            return thread;
          }

          return {
            ...thread,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            modelSelection,
            ...(event.payload.envMode !== undefined ? { envMode: event.payload.envMode } : {}),
            branch: nextBranch,
            worktreePath: nextWorktreePath,
            associatedWorktreePath: nextAssociatedWorktreePath,
            associatedWorktreeBranch: nextAssociatedWorktreeBranch,
            associatedWorktreeRef: nextAssociatedWorktreeRef,
            createBranchFlowCompleted: nextCreateBranchFlowCompleted,
            ...(event.payload.isPinned !== undefined ? { isPinned: event.payload.isPinned } : {}),
            ...(event.payload.pinnedMessages !== undefined
              ? { pinnedMessages: [...event.payload.pinnedMessages] }
              : {}),
            ...(event.payload.threadMarkers !== undefined
              ? { threadMarkers: [...event.payload.threadMarkers] }
              : {}),
            ...(event.payload.notes !== undefined ? { notes: event.payload.notes } : {}),
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
            updatedAt: nextUpdatedAt,
            ...(cwdChanged ? { session: null } : {}),
          };
        },
        {
          ...options,
          updateThreadArray:
            options?.updateThreadArray !== false || event.payload.title !== undefined,
          updateSidebarSummary: true,
        },
      );

    case "thread.message-sent":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => applyThreadMessageSentEvent(thread, event),
        {
          ...options,
          recomputeSummarySignals: threadMessageUpdatesSummary(event),
          updateSidebarSummary:
            options?.updateSidebarSummary === true || threadMessageUpdatesSidebarSummary(event),
        },
      );

    case "thread.deleted":
      return removeThreadState(state, event.payload.threadId);

    case "thread.pinned-message-added":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const currentPins = thread.pinnedMessages ?? [];
          const hasPin = currentPins.some((pin) => pin.messageId === event.payload.pin.messageId);
          const pinnedMessages = hasPin
            ? currentPins.map((pin) =>
                pin.messageId === event.payload.pin.messageId ? event.payload.pin : pin,
              )
            : [...currentPins, event.payload.pin];
          if (arraysShallowEqual(currentPins, pinnedMessages)) {
            return thread;
          }
          return {
            ...thread,
            pinnedMessages,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.payload.updatedAt
                ? thread.updatedAt
                : event.payload.updatedAt,
          };
        },
        { ...options, updateSidebarSummary: true },
      );

    case "thread.pinned-message-removed":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const currentPins = thread.pinnedMessages ?? [];
          const pinnedMessages = currentPins.filter(
            (pin) => pin.messageId !== event.payload.messageId,
          );
          if (pinnedMessages.length === currentPins.length) {
            return thread;
          }
          return {
            ...thread,
            pinnedMessages,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.payload.updatedAt
                ? thread.updatedAt
                : event.payload.updatedAt,
          };
        },
        { ...options, updateSidebarSummary: true },
      );

    case "thread.pinned-message-done-set":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          let changed = false;
          const pinnedMessages = (thread.pinnedMessages ?? []).map((pin) => {
            if (pin.messageId !== event.payload.messageId || pin.done === event.payload.done) {
              return pin;
            }
            changed = true;
            return { ...pin, done: event.payload.done };
          });
          if (!changed) {
            return thread;
          }
          return {
            ...thread,
            pinnedMessages,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.payload.updatedAt
                ? thread.updatedAt
                : event.payload.updatedAt,
          };
        },
        { ...options, updateSidebarSummary: true },
      );

    case "thread.pinned-message-label-set":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          let changed = false;
          const pinnedMessages = (thread.pinnedMessages ?? []).map((pin) => {
            if (pin.messageId !== event.payload.messageId || pin.label === event.payload.label) {
              return pin;
            }
            changed = true;
            return { ...pin, label: event.payload.label };
          });
          if (!changed) {
            return thread;
          }
          return {
            ...thread,
            pinnedMessages,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.payload.updatedAt
                ? thread.updatedAt
                : event.payload.updatedAt,
          };
        },
        { ...options, updateSidebarSummary: true },
      );

    case "thread.marker-added":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const currentMarkers = thread.threadMarkers ?? [];
          const hasMarker = currentMarkers.some((marker) => marker.id === event.payload.marker.id);
          const threadMarkers = hasMarker
            ? currentMarkers.map((marker) =>
                marker.id === event.payload.marker.id ? event.payload.marker : marker,
              )
            : [...currentMarkers, event.payload.marker];
          if (arraysShallowEqual(currentMarkers, threadMarkers)) {
            return thread;
          }
          return {
            ...thread,
            threadMarkers,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.payload.updatedAt
                ? thread.updatedAt
                : event.payload.updatedAt,
          };
        },
        { ...options, updateSidebarSummary: true },
      );

    case "thread.marker-removed":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const currentMarkers = thread.threadMarkers ?? [];
          const threadMarkers = currentMarkers.filter(
            (marker) => marker.id !== event.payload.markerId,
          );
          if (threadMarkers.length === currentMarkers.length) {
            return thread;
          }
          return {
            ...thread,
            threadMarkers,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.payload.updatedAt
                ? thread.updatedAt
                : event.payload.updatedAt,
          };
        },
        { ...options, updateSidebarSummary: true },
      );

    case "thread.marker-done-set":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          let changed = false;
          const threadMarkers = (thread.threadMarkers ?? []).map((marker) => {
            if (marker.id !== event.payload.markerId || marker.done === event.payload.done) {
              return marker;
            }
            changed = true;
            return {
              ...marker,
              done: event.payload.done,
              updatedAt: event.payload.updatedAt,
            };
          });
          if (!changed) {
            return thread;
          }
          return {
            ...thread,
            threadMarkers,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.payload.updatedAt
                ? thread.updatedAt
                : event.payload.updatedAt,
          };
        },
        { ...options, updateSidebarSummary: true },
      );

    case "thread.marker-label-set":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          let changed = false;
          const threadMarkers = (thread.threadMarkers ?? []).map((marker) => {
            if (marker.id !== event.payload.markerId || marker.label === event.payload.label) {
              return marker;
            }
            changed = true;
            return {
              ...marker,
              label: event.payload.label,
              updatedAt: event.payload.updatedAt,
            };
          });
          if (!changed) {
            return thread;
          }
          return {
            ...thread,
            threadMarkers,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.payload.updatedAt
                ? thread.updatedAt
                : event.payload.updatedAt,
          };
        },
        { ...options, updateSidebarSummary: true },
      );

    case "thread.session-set":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const session = normalizeThreadSession(event.payload.session, thread.session);
          const error = normalizeThreadErrorMessage(event.payload.session.lastError);
          const latestTurn = reconcileLatestTurnFromSession(thread, event.payload.session, error);
          if (
            session === thread.session &&
            error === thread.error &&
            latestTurn === thread.latestTurn
          ) {
            return thread;
          }
          return {
            ...thread,
            session,
            error,
            latestTurn,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.occurredAt
                ? thread.updatedAt
                : event.occurredAt,
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.turn-interrupt-requested": {
      // Interrupt requests are best-effort and can fail or time out. Keep the
      // latest-turn clock/state live until the provider confirms a terminal event.
      return state;
    }

    case "thread.session-stop-requested":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          if (thread.session === null) {
            return thread;
          }
          const latestTurn =
            thread.latestTurn !== null &&
            thread.latestTurn.state === "running" &&
            thread.latestTurn.completedAt === null
              ? buildLatestTurn({
                  previous: thread.latestTurn,
                  turnId: thread.latestTurn.turnId,
                  state: "interrupted",
                  requestedAt: thread.latestTurn.requestedAt,
                  startedAt: thread.latestTurn.startedAt ?? event.payload.createdAt,
                  completedAt: event.payload.createdAt,
                  assistantMessageId: thread.latestTurn.assistantMessageId,
                })
              : thread.latestTurn;
          return {
            ...thread,
            session: {
              ...thread.session,
              status: "closed",
              orchestrationStatus: "stopped",
              activeTurnId: undefined,
              updatedAt: event.payload.createdAt,
            },
            latestTurn,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.occurredAt
                ? thread.updatedAt
                : event.occurredAt,
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.turn-start-requested":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const modelSelection =
            event.payload.modelSelection !== undefined
              ? normalizeModelSelection(event.payload.modelSelection, thread.modelSelection)
              : thread.modelSelection;
          if (
            modelSelection === thread.modelSelection &&
            thread.runtimeMode === event.payload.runtimeMode &&
            thread.interactionMode === event.payload.interactionMode &&
            thread.pendingSourceProposedPlan === event.payload.sourceProposedPlan &&
            (thread.updatedAt ?? thread.createdAt) >= event.payload.createdAt
          ) {
            return thread;
          }
          return {
            ...thread,
            modelSelection,
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
            pendingSourceProposedPlan: event.payload.sourceProposedPlan,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.payload.createdAt
                ? thread.updatedAt
                : event.payload.createdAt,
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.user-input-response-requested":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          // Hide the composer prompt as soon as the response command is accepted;
          // the provider may append its own resolved activity shortly after.
          const syntheticResolvedActivity = {
            id: EventId.makeUnsafe(
              `synthetic-user-input-resolved:${event.payload.requestId}:${event.sequence}`,
            ),
            tone: "info",
            kind: "user-input.resolved",
            summary: "User input submitted",
            payload: {
              requestId: event.payload.requestId,
            },
            turnId: null,
            sequence: event.sequence,
            createdAt: event.payload.createdAt,
          } satisfies Thread["activities"][number];
          const hasResolvedActivity = thread.activities.some(
            (activity) => activity.id === syntheticResolvedActivity.id,
          );
          const activities = hasResolvedActivity
            ? thread.activities
            : [...thread.activities, syntheticResolvedActivity];
          const summary = resolveThreadSummaryAfterUserInputResponseRequested(thread, event);
          return {
            ...thread,
            activities,
            hasPendingUserInput: summary.hasPendingUserInput,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.payload.createdAt
                ? thread.updatedAt
                : event.payload.createdAt,
          };
        },
        {
          ...options,
          recomputeSummarySignals: false,
          updateSidebarSummary: true,
        },
      );

    case "thread.approval-response-requested":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const summary = resolveThreadSummaryAfterApprovalResponseRequested(thread, event);
          return {
            ...thread,
            hasPendingApprovals: summary.hasPendingApprovals,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.payload.createdAt
                ? thread.updatedAt
                : event.payload.createdAt,
          };
        },
        {
          ...options,
          recomputeSummarySignals: false,
          updateSidebarSummary: true,
        },
      );

    case "thread.activity-appended":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const nextActivities = normalizeActivities(
            [...thread.activities, event.payload.activity],
            thread.activities,
          );
          if (nextActivities === thread.activities) {
            return thread;
          }
          return {
            ...thread,
            activities: nextActivities,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.payload.activity.createdAt
                ? thread.updatedAt
                : event.payload.activity.createdAt,
          };
        },
        {
          ...options,
          recomputeSummarySignals: threadActivityUpdatesSummary(event),
          updateSidebarSummary:
            options?.updateSidebarSummary === true || threadActivityUpdatesSummary(event),
        },
      );

    case "thread.proposed-plan-upserted":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const previousPlanIndex = thread.proposedPlans.findIndex(
            (plan) => plan.id === event.payload.proposedPlan.id,
          );
          const nextPlan = normalizeProposedPlans(
            [event.payload.proposedPlan],
            previousPlanIndex >= 0 ? [thread.proposedPlans[previousPlanIndex]!] : undefined,
          )[0];
          if (!nextPlan) {
            return thread;
          }
          const proposedPlans =
            previousPlanIndex >= 0
              ? thread.proposedPlans.map((plan, index) =>
                  index === previousPlanIndex ? nextPlan : plan,
                )
              : [...thread.proposedPlans, nextPlan];
          if (arraysShallowEqual(thread.proposedPlans, proposedPlans)) {
            return thread;
          }
          return {
            ...thread,
            proposedPlans,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.payload.proposedPlan.updatedAt
                ? thread.updatedAt
                : event.payload.proposedPlan.updatedAt,
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.turn-diff-completed":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) =>
          applyTurnDiffSummaryToThread(thread, {
            turnId: event.payload.turnId,
            completedAt: event.payload.completedAt,
            status: event.payload.status,
            files: event.payload.files.map((file) => ({
              path: file.path,
              ...(file.kind !== undefined ? { kind: file.kind } : {}),
              ...(file.additions !== undefined ? { additions: file.additions } : {}),
              ...(file.deletions !== undefined ? { deletions: file.deletions } : {}),
            })),
            checkpointRef: event.payload.checkpointRef,
            assistantMessageId: event.payload.assistantMessageId ?? undefined,
            checkpointTurnCount: event.payload.checkpointTurnCount,
          }),
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.reverted":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const turnDiffSummaries = thread.turnDiffSummaries
            .filter(
              (entry) =>
                entry.checkpointTurnCount !== undefined &&
                entry.checkpointTurnCount <= event.payload.turnCount,
            )
            .toSorted(
              (left, right) =>
                (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
                (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
            );
          const retainedTurnIds = new Set(turnDiffSummaries.map((entry) => entry.turnId));
          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            event.payload.turnCount,
          ).slice(-MAX_THREAD_MESSAGES);
          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          );
          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);
          const latestCheckpoint = turnDiffSummaries.at(-1) ?? null;

          return {
            ...thread,
            turnDiffSummaries,
            messages,
            proposedPlans,
            activities,
            pendingSourceProposedPlan: undefined,
            latestTurn:
              latestCheckpoint === null
                ? null
                : {
                    turnId: latestCheckpoint.turnId,
                    state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                    requestedAt: latestCheckpoint.completedAt,
                    startedAt: latestCheckpoint.completedAt,
                    completedAt: latestCheckpoint.completedAt,
                    assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                  },
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.occurredAt
                ? thread.updatedAt
                : event.occurredAt,
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.conversation-rolled-back":
      if (event.payload.numTurns === 0) {
        return state;
      }
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const rollback = rollbackThreadMessagesFromMessage(
            thread.messages,
            event.payload.messageId,
          );
          const removedTurnIds = new Set([
            ...rollback.removedTurnIds,
            ...(event.payload.removedTurnIds ?? []),
          ]);
          if (rollback.messages.length === thread.messages.length && removedTurnIds.size === 0) {
            return thread;
          }

          const turnDiffSummaries = thread.turnDiffSummaries
            .filter((entry) => !removedTurnIds.has(entry.turnId))
            .toSorted(
              (left, right) =>
                (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
                (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
            );
          const proposedPlans = thread.proposedPlans.filter(
            (plan) => plan.turnId === null || !removedTurnIds.has(plan.turnId),
          );
          const activities = thread.activities.filter(
            (activity) => activity.turnId === null || !removedTurnIds.has(activity.turnId),
          );
          const latestCheckpoint = turnDiffSummaries.at(-1) ?? null;

          return {
            ...thread,
            turnDiffSummaries,
            messages: rollback.messages.slice(-MAX_THREAD_MESSAGES),
            proposedPlans,
            activities,
            pendingSourceProposedPlan: undefined,
            latestTurn:
              latestCheckpoint === null
                ? null
                : {
                    turnId: latestCheckpoint.turnId,
                    state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                    requestedAt: latestCheckpoint.completedAt,
                    startedAt: latestCheckpoint.completedAt,
                    completedAt: latestCheckpoint.completedAt,
                    assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                  },
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.occurredAt
                ? thread.updatedAt
                : event.occurredAt,
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.archived":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => ({
          ...thread,
          archivedAt: event.payload.archivedAt ?? event.occurredAt,
          updatedAt: event.payload.updatedAt ?? event.occurredAt,
        }),
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.unarchived":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => ({
          ...thread,
          archivedAt: null,
          updatedAt: event.payload.updatedAt ?? event.occurredAt,
        }),
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    default:
      return state;
  }
}
