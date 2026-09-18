import {
  ApprovalRequestId,
  COMPUTER_GRANT_ACTION_CLASSES,
  type ComputerGrantActionClass,
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

import { orderedActivities } from "./workLog";

export interface PendingApproval {
  requestId: ApprovalRequestId;
  lifecycleGeneration?: string;
  /** Changes only when the durable retryable response attempt changes. */
  responseAttemptKey?: string;
  requestKind: "command" | "file-read" | "file-change" | "permissions" | "tool";
  createdAt: string;
  detail?: string;
  permissionProfile?: Record<string, unknown>;
  sessionApprovalAvailable?: boolean;
  approvalScope?: "computer-task";
  toolName?: string;
  toolParamsDisplay?: ReadonlyArray<PendingToolParamDisplay>;
  /**
   * The durable always-allow scope a computer approval offers to pin. When
   * present the card may answer "accept" with a matching `computerGrant`
   * choice; absent means this prompt can only mint a one-time answer.
   */
  computerGrantOffer?: PendingComputerGrantOffer;
}

export interface PendingComputerGrantOffer {
  readonly apps: ReadonlyArray<{
    readonly name?: string;
    readonly bundleId?: string;
    readonly teamId?: string;
  }>;
  readonly classes: ReadonlyArray<ComputerGrantActionClass>;
  readonly scopes: ReadonlyArray<"app" | "any-app">;
  readonly defaultTtlMs: number;
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
  // Aggregate flags cannot identify a pending request. When detailed
  // settlements are missing, an explicit false clears everything. Undefined
  // trusts only latest-turn requests; true additionally retains the newest
  // unresolved older request so a background prompt can outlive later turns.
  readonly authoritativeHasPending: boolean | undefined;
  readonly latestTurnId: TurnId | undefined;
  // The active composer supplies a wall-clock reference so durable failures
  // and orphaned response claims become actionable under the same atomic
  // reclaim policy enforced by persistence. Historical/sidebar derivations
  // can omit it to remain time-independent.
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
      // While aggregate state is absent, only a request tied to the latest turn
      // is fresh enough to trust. An explicit true is stronger evidence: replay
      // all request lifecycles, then bound the ambiguous result below.
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

  // Explicit stale-callback failures are terminal for their request instance.
  // Apply them after replay: their orchestration sequence may be below an older
  // request's runtime sequence, which must not resurrect an invalid callback.
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
      // A boolean shell cannot express concurrent older interactions. Keep the
      // newest unresolved lifecycle as the safest actionable fallback; current
      // servers provide detailed settlements and preserve all concurrency.
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

/**
 * The offer rides the open prompt's payload untyped — a JSON string like
 * `toolParamsDisplay` on the same card, or an already-parsed object — so
 * every field is re-validated here: an offer with no classes or no scopes
 * cannot mint an honest grant and is dropped rather than partially rendered.
 */
function parseComputerGrantOffer(value: unknown): PendingComputerGrantOffer | undefined {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return undefined;
          }
        })()
      : value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const classes = Array.isArray(record.classes)
    ? record.classes.filter(
        (entry): entry is ComputerGrantActionClass =>
          typeof entry === "string" &&
          (COMPUTER_GRANT_ACTION_CLASSES as readonly string[]).includes(entry),
      )
    : [];
  if (classes.length === 0) return undefined;
  const scopes = Array.isArray(record.scopes)
    ? [...new Set(record.scopes.filter((entry) => entry === "app" || entry === "any-app"))]
    : [];
  if (scopes.length === 0) return undefined;
  const apps = Array.isArray(record.apps)
    ? record.apps.flatMap<NonNullable<PendingComputerGrantOffer["apps"][number]>>((entry) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
        const identity = entry as Record<string, unknown>;
        const app = {
          ...(typeof identity.name === "string" && identity.name.length > 0
            ? { name: identity.name }
            : {}),
          ...(typeof identity.bundleId === "string" && identity.bundleId.length > 0
            ? { bundleId: identity.bundleId }
            : {}),
          ...(typeof identity.teamId === "string" && identity.teamId.length > 0
            ? { teamId: identity.teamId }
            : {}),
        };
        return app.name !== undefined || app.bundleId !== undefined ? [app] : [];
      })
    : [];
  const defaultTtlMs =
    typeof record.defaultTtlMs === "number" &&
    Number.isSafeInteger(record.defaultTtlMs) &&
    record.defaultTtlMs > 0
      ? record.defaultTtlMs
      : 0;
  return {
    apps,
    classes: [...new Set(classes)],
    scopes: scopes as Array<"app" | "any-app">,
    defaultTtlMs,
  };
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
        const computerGrantOffer = parseComputerGrantOffer(payload?.computerGrantOffer);
        return {
          requestId,
          ...(lifecycleGeneration !== undefined ? { lifecycleGeneration } : {}),
          requestKind,
          createdAt: activity.createdAt,
          ...(detail ? { detail } : {}),
          ...(permissionProfile ? { permissionProfile } : {}),
          ...(sessionApprovalAvailable !== undefined ? { sessionApprovalAvailable } : {}),
          ...(payload?.approvalScope === "computer-task"
            ? { approvalScope: "computer-task" as const }
            : {}),
          ...(toolName ? { toolName } : {}),
          ...(toolParamsDisplay ? { toolParamsDisplay } : {}),
          ...(computerGrantOffer ? { computerGrantOffer } : {}),
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
