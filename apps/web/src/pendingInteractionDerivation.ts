import {
  ApprovalRequestId,
  type OrchestrationPendingInteraction,
  type OrchestrationThreadActivity,
  type TurnId,
  type UserInputQuestion,
} from "@synara/contracts";
import {
  createStalePendingInteractionMatcher,
  isPendingInteractionResponseClaimable,
} from "@synara/shared/pendingInteractions";
import {
  approvalRequestKindFromRequestType,
  pendingRequestInstanceKey,
} from "@synara/shared/threadSummary";

import { orderedActivities, parseUserInputQuestions } from "./workLog";

export interface PendingApproval {
  requestId: ApprovalRequestId;
  lifecycleGeneration?: string;
  responseAttemptKey?: string;
  requestKind: "command" | "file-read" | "file-change" | "permissions" | "tool";
  createdAt: string;
  detail?: string;
  permissionProfile?: Record<string, unknown>;
  sessionApprovalAvailable?: boolean;
  approvalScope?: "computer-task" | "computer-foreground" | "device-task";
  toolName?: string;
  toolParamsDisplay?: ReadonlyArray<PendingToolParamDisplay>;
}

export interface PendingToolParamDisplay {
  name: string;
  value: unknown;
  displayName?: string;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  lifecycleGeneration?: string;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

type PendingInteractionKind = OrchestrationPendingInteraction["interactionKind"];

export interface PendingInteractionDerivationOptions {
  // undefined trusts only latest-turn requests; true additionally retains the newest unresolved older request so a background prompt outlives later turns
  readonly authoritativeHasPending: boolean | undefined;
  readonly latestTurnId: TurnId | undefined;
  // the active composer supplies the wall-clock so durable failures and orphaned response claims are actionable under persistence's atomic reclaim policy
  readonly responseClaimReferenceAt?: string;
}

interface PendingInteractionReplay<T extends { requestId: ApprovalRequestId }> {
  interactionKind: PendingInteractionKind;
  requestedActivityKind: string;
  resolvedActivityKind: string;
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
  responseClaimReferenceAt: string | undefined,
): void {
  if (settlements === undefined) {
    return;
  }
  const actionableKeys = new Set(
    settlements
      .filter(
        (settlement) =>
          settlement.interactionKind === interactionKind &&
          (settlement.status === "pending" ||
            settlement.status === "retryable" ||
            (responseClaimReferenceAt !== undefined &&
              isPendingInteractionResponseClaimable({
                status: settlement.status,
                responseRequestedAt: settlement.responseRequestedAt,
                requestedAt: responseClaimReferenceAt,
              }))),
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

function replayPendingInteractions<
  T extends { requestId: ApprovalRequestId; createdAt: string; lifecycleGeneration?: string },
>(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  settlements: ReadonlyArray<OrchestrationPendingInteraction> | undefined,
  replay: PendingInteractionReplay<T>,
  options?: PendingInteractionDerivationOptions,
): T[] {
  const openByInstance = new Map<string, T>();
  const isAggregateFallback = settlements === undefined && options !== undefined;
  const fallbackLatestTurnId = isAggregateFallback ? options.latestTurnId : undefined;
  const latestTurnRequestedKeys = new Set<string>();
  const replayActivities =
    !isAggregateFallback || options.authoritativeHasPending !== false ? activities : [];

  for (const activity of orderedActivities(replayActivities)) {
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
      const isLatestTurnRequest =
        fallbackLatestTurnId !== undefined && activity.turnId === fallbackLatestTurnId;
      // while aggregate state is absent only a latest-turn request is fresh enough to trust — explicit true is stronger: replay all request lifecycles, then bound the ambiguous result
      if (isAggregateFallback && options.authoritativeHasPending !== true && !isLatestTurnRequest) {
        continue;
      }
      const pending = replay.parseRequested({
        activity,
        payload,
        requestId,
        lifecycleGeneration,
      });
      if (pending) {
        replacePendingInteraction(openByInstance, pending, lifecycleGeneration);
        if (isLatestTurnRequest) {
          latestTurnRequestedKeys.add(
            pendingRequestInstanceKey(pending.requestId, lifecycleGeneration),
          );
        }
      }
      continue;
    }

    if (activity.kind === replay.resolvedActivityKind) {
      deletePendingInteraction(openByInstance, requestId, lifecycleGeneration);
      continue;
    }
  }

  // explicit stale-callback failures are terminal — apply after replay since their orchestration seq may sit below an older request's runtime seq, which must not resurrect an invalid callback
  if (openByInstance.size > 0) {
    const isStale = createStalePendingInteractionMatcher(replayActivities);
    for (const [key, pending] of openByInstance) {
      if (isStale({ ...pending, interactionKind: replay.interactionKind })) {
        openByInstance.delete(key);
      }
    }
  }
  retainActionableSettlements(
    openByInstance,
    settlements,
    replay.interactionKind,
    options?.responseClaimReferenceAt,
  );
  if (isAggregateFallback && options.authoritativeHasPending === true) {
    const actionableLatestTurnKeys = [...openByInstance.keys()].filter((key) =>
      latestTurnRequestedKeys.has(key),
    );
    if (actionableLatestTurnKeys.length > 0) {
      const retainedKeys = new Set(actionableLatestTurnKeys);
      for (const key of openByInstance.keys()) {
        if (!retainedKeys.has(key)) {
          openByInstance.delete(key);
        }
      }
    } else if (openByInstance.size > 1) {
      // a boolean shell can't express concurrent older interactions — keep the newest unresolved lifecycle as the safest actionable fallback
      const newest = [...openByInstance.entries()]
        .toSorted(([, left], [, right]) =>
          left.createdAt === right.createdAt
            ? left.requestId.localeCompare(right.requestId)
            : left.createdAt.localeCompare(right.createdAt),
        )
        .at(-1);
      openByInstance.clear();
      if (newest) {
        openByInstance.set(newest[0], newest[1]);
      }
    }
  }
  return [...openByInstance.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  settlements?: ReadonlyArray<OrchestrationPendingInteraction>,
  options?: PendingInteractionDerivationOptions,
): PendingApproval[] {
  const approvals = replayPendingInteractions(
    activities,
    settlements,
    {
      interactionKind: "approval",
      requestedActivityKind: "approval.requested",
      resolvedActivityKind: "approval.resolved",
      parseRequested: ({ activity, payload, requestId, lifecycleGeneration }) => {
        const requestKind =
          payload?.requestKind === "command" ||
          payload?.requestKind === "file-read" ||
          payload?.requestKind === "file-change" ||
          payload?.requestKind === "permissions" ||
          payload?.requestKind === "tool"
            ? payload.requestKind
            : approvalRequestKindFromRequestType(payload?.requestType);
        if (!requestKind) {
          return null;
        }
        const detail = typeof payload?.detail === "string" ? payload.detail : undefined;
        const permissionProfile =
          payload?.permissionProfile !== null &&
          typeof payload?.permissionProfile === "object" &&
          !Array.isArray(payload.permissionProfile)
            ? (payload.permissionProfile as Record<string, unknown>)
            : undefined;
        const sessionApprovalAvailable =
          typeof payload?.sessionApprovalAvailable === "boolean"
            ? payload.sessionApprovalAvailable
            : undefined;
        const toolName = typeof payload?.toolName === "string" ? payload.toolName : undefined;
        const toolParamsDisplay = parseToolParamsDisplay(payload?.toolParamsDisplay);
        return {
          requestId,
          ...(lifecycleGeneration !== undefined ? { lifecycleGeneration } : {}),
          requestKind,
          createdAt: activity.createdAt,
          ...(detail ? { detail } : {}),
          ...(permissionProfile ? { permissionProfile } : {}),
          ...(sessionApprovalAvailable !== undefined ? { sessionApprovalAvailable } : {}),
          ...(payload?.approvalScope === "computer-task" || payload?.approvalScope === "device-task"
            ? { approvalScope: payload.approvalScope as "computer-task" | "device-task" }
            : payload?.approvalScope === "computer-foreground"
              ? { approvalScope: "computer-foreground" as const }
              : {}),
          ...(toolName ? { toolName } : {}),
          ...(toolParamsDisplay ? { toolParamsDisplay } : {}),
        };
      },
    },
    options,
  );
  if (settlements === undefined) {
    return approvals;
  }

  const retryableAttemptKeys = new Map<string, string>();
  for (const settlement of settlements) {
    if (settlement.interactionKind !== "approval" || settlement.status !== "retryable") {
      continue;
    }
    retryableAttemptKeys.set(
      pendingRequestInstanceKey(settlement.requestId, settlement.lifecycleGeneration ?? undefined),
      JSON.stringify([settlement.responseCommandId, settlement.responseRequestedAt]),
    );
  }

  return approvals.map((approval) => {
    const responseAttemptKey = retryableAttemptKeys.get(
      pendingRequestInstanceKey(approval.requestId, approval.lifecycleGeneration),
    );
    return responseAttemptKey === undefined ? approval : { ...approval, responseAttemptKey };
  });
}

function parseToolParamsDisplay(
  value: unknown,
): ReadonlyArray<PendingToolParamDisplay> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value.flatMap<PendingToolParamDisplay>((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || !Object.hasOwn(record, "value")) {
      return [];
    }
    const displayName =
      typeof record.displayName === "string"
        ? record.displayName
        : typeof record.display_name === "string"
          ? record.display_name
          : undefined;
    return [
      {
        name: record.name,
        value: record.value,
        ...(displayName ? { displayName } : {}),
      },
    ];
  });
  return entries.length > 0 ? entries : undefined;
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  settlements?: ReadonlyArray<OrchestrationPendingInteraction>,
  options?: PendingInteractionDerivationOptions,
): PendingUserInput[] {
  return replayPendingInteractions(
    activities,
    settlements,
    {
      interactionKind: "userInput",
      requestedActivityKind: "user-input.requested",
      resolvedActivityKind: "user-input.resolved",
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
    },
    options,
  );
}
