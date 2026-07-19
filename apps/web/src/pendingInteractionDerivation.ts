import {
  ApprovalRequestId,
  type OrchestrationPendingInteraction,
  type OrchestrationThreadActivity,
  type UserInputQuestion,
} from "@synara/contracts";
import { pendingRequestInstanceKey } from "@synara/shared/threadSummary";

import { isStalePendingRequestFailureDetail } from "./lib/pendingInteraction";
import { orderedActivities, requestKindFromRequestType } from "./workLog";

export interface PendingApproval {
  requestId: ApprovalRequestId;
  lifecycleGeneration?: string;
  requestKind: "command" | "file-read" | "file-change";
  createdAt: string;
  detail?: string;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  lifecycleGeneration?: string;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

type PendingInteractionKind = OrchestrationPendingInteraction["interactionKind"];

interface PendingInteractionReplay<T extends { requestId: ApprovalRequestId }> {
  interactionKind: PendingInteractionKind;
  requestedActivityKind: string;
  resolvedActivityKind: string;
  responseFailedActivityKind: string;
  parseRequested: (input: {
    activity: OrchestrationThreadActivity;
    payload: Record<string, unknown> | null;
    requestId: ApprovalRequestId;
    lifecycleGeneration: string | undefined;
  }) => T | null;
}

function activityPayload(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return activity.payload && typeof activity.payload === "object"
    ? (activity.payload as Record<string, unknown>)
    : null;
}

function activityLifecycleGeneration(payload: Record<string, unknown> | null): string | undefined {
  const generation = payload?.lifecycleGeneration;
  return typeof generation === "string" && generation.length > 0 ? generation : undefined;
}

function deletePendingInteraction<T extends { requestId: ApprovalRequestId }>(
  openByInstance: Map<string, T>,
  requestId: ApprovalRequestId,
  lifecycleGeneration: string | undefined,
): void {
  if (lifecycleGeneration !== undefined) {
    openByInstance.delete(pendingRequestInstanceKey(requestId, lifecycleGeneration));
    return;
  }
  for (const [key, pending] of openByInstance) {
    if (pending.requestId === requestId) openByInstance.delete(key);
  }
}

function replacePendingInteraction<T extends { requestId: ApprovalRequestId }>(
  openByInstance: Map<string, T>,
  pending: T,
  lifecycleGeneration: string | undefined,
): void {
  deletePendingInteraction(openByInstance, pending.requestId, undefined);
  openByInstance.set(pendingRequestInstanceKey(pending.requestId, lifecycleGeneration), pending);
}

function retainActionableSettlements<T extends { requestId: ApprovalRequestId }>(
  openByInstance: Map<string, T>,
  settlements: ReadonlyArray<OrchestrationPendingInteraction> | undefined,
  interactionKind: PendingInteractionKind,
): void {
  if (settlements === undefined) {
    return;
  }
  const actionableKeys = new Set(
    settlements
      .filter(
        (settlement) =>
          settlement.interactionKind === interactionKind &&
          (settlement.status === "pending" || settlement.status === "retryable"),
      )
      .map((settlement) =>
        pendingRequestInstanceKey(
          settlement.requestId,
          settlement.lifecycleGeneration ?? undefined,
        ),
      ),
  );
  for (const key of openByInstance.keys()) {
    if (!actionableKeys.has(key)) {
      openByInstance.delete(key);
    }
  }
}

function replayPendingInteractions<T extends { requestId: ApprovalRequestId; createdAt: string }>(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  settlements: ReadonlyArray<OrchestrationPendingInteraction> | undefined,
  replay: PendingInteractionReplay<T>,
): T[] {
  const openByInstance = new Map<string, T>();

  for (const activity of orderedActivities(activities)) {
    const payload = activityPayload(activity);
    const requestId =
      typeof payload?.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    if (!requestId) {
      continue;
    }

    const lifecycleGeneration = activityLifecycleGeneration(payload);
    if (activity.kind === replay.requestedActivityKind) {
      const pending = replay.parseRequested({
        activity,
        payload,
        requestId,
        lifecycleGeneration,
      });
      if (pending) {
        replacePendingInteraction(openByInstance, pending, lifecycleGeneration);
      }
      continue;
    }

    if (activity.kind === replay.resolvedActivityKind) {
      deletePendingInteraction(openByInstance, requestId, lifecycleGeneration);
      continue;
    }

    const detail = typeof payload?.detail === "string" ? payload.detail : undefined;
    if (
      activity.kind === replay.responseFailedActivityKind &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      deletePendingInteraction(openByInstance, requestId, lifecycleGeneration);
    }
  }

  retainActionableSettlements(openByInstance, settlements, replay.interactionKind);
  return [...openByInstance.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
        ...(question.multiSelect === true ? { multiSelect: true } : {}),
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  settlements?: ReadonlyArray<OrchestrationPendingInteraction>,
): PendingApproval[] {
  return replayPendingInteractions(activities, settlements, {
    interactionKind: "approval",
    requestedActivityKind: "approval.requested",
    resolvedActivityKind: "approval.resolved",
    responseFailedActivityKind: "provider.approval.respond.failed",
    parseRequested: ({ activity, payload, requestId, lifecycleGeneration }) => {
      const requestKind =
        payload?.requestKind === "command" ||
        payload?.requestKind === "file-read" ||
        payload?.requestKind === "file-change"
          ? payload.requestKind
          : requestKindFromRequestType(payload?.requestType);
      if (!requestKind) {
        return null;
      }
      const detail = typeof payload?.detail === "string" ? payload.detail : undefined;
      return {
        requestId,
        ...(lifecycleGeneration !== undefined ? { lifecycleGeneration } : {}),
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
      };
    },
  });
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  settlements?: ReadonlyArray<OrchestrationPendingInteraction>,
): PendingUserInput[] {
  return replayPendingInteractions(activities, settlements, {
    interactionKind: "userInput",
    requestedActivityKind: "user-input.requested",
    resolvedActivityKind: "user-input.resolved",
    responseFailedActivityKind: "provider.user-input.respond.failed",
    parseRequested: ({ activity, payload, requestId, lifecycleGeneration }) => {
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        return null;
      }
      return {
        requestId,
        ...(lifecycleGeneration !== undefined ? { lifecycleGeneration } : {}),
        createdAt: activity.createdAt,
        questions,
      };
    },
  });
}
