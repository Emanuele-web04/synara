import { ApprovalRequestId, type OrchestrationEvent } from "@t3tools/contracts";

import type { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import type { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import type { ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import type { ProjectionThreadRuntime } from "../../persistence/Services/ProjectionThreadRuntime.ts";
import type { ProjectionTurn } from "../../persistence/Services/ProjectionTurns.ts";
import {
  attachmentRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";
import { THREAD_SHELL_SUMMARY_ACTIVITY_KINDS } from "./ProjectionPipeline.types.ts";

export function finalizeTurnStateFromSessionStatus(
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

export function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.makeUnsafe(requestId) : null;
}

export function isStalePendingApprovalFailure(payload: unknown): boolean {
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

export function isThreadRuntimeEvent(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.runtime-provision-requested":
    case "thread.runtime-instance-created":
    case "thread.runtime-instance-state-changed":
    case "thread.runtime-process-started":
    case "thread.runtime-process-output":
    case "thread.runtime-process-completed":
    case "thread.runtime-route-exposed":
    case "thread.runtime-snapshot-created":
    case "thread.runtime-lease-renewed":
    case "thread.runtime-destroyed":
    case "thread.runtime-failed":
      return true;
    default:
      return false;
  }
}

export function shouldRefreshThreadShellSummary(event: OrchestrationEvent): boolean {
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

export function retainProjectionMessagesAfterRevert(
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

export function retainProjectionActivitiesAfterRevert(
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

export function retainProjectionProposedPlansAfterRevert(
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

export function rollbackProjectionMessagesFromMessage(
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

export function retainProjectionTurnsAfterConversationRollback(
  turns: ReadonlyArray<ProjectionTurn>,
  removedTurnIds: ReadonlySet<string>,
): ReadonlyArray<ProjectionTurn> {
  if (removedTurnIds.size === 0) {
    return turns;
  }
  return turns.filter((turn) => turn.turnId === null || !removedTurnIds.has(turn.turnId));
}

export function retainProjectionActivitiesAfterConversationRollback(
  activities: ReadonlyArray<ProjectionThreadActivity>,
  removedTurnIds: ReadonlySet<string>,
): ReadonlyArray<ProjectionThreadActivity> {
  return activities.filter(
    (activity) => activity.turnId === null || !removedTurnIds.has(activity.turnId),
  );
}

export function retainProjectionProposedPlansAfterConversationRollback(
  proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>,
  removedTurnIds: ReadonlySet<string>,
): ReadonlyArray<ProjectionThreadProposedPlan> {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || !removedTurnIds.has(proposedPlan.turnId),
  );
}

export function collectThreadAttachmentRelativePaths(
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

// Bounded short tail kept per process; `runtime-process-output` is stream-only
// so we keep a small tail, never a row per line, to protect dispatch latency.
export const RUNTIME_PROCESS_TAIL_MAX_CHARS = 4_000;

export const clampRuntimeTail = (tail: string): string =>
  tail.length <= RUNTIME_PROCESS_TAIL_MAX_CHARS
    ? tail
    : tail.slice(tail.length - RUNTIME_PROCESS_TAIL_MAX_CHARS);

export const emptyRuntimeReadModel = (input: {
  readonly threadId: ProjectionThreadRuntime["threadId"];
  readonly targetKind: ProjectionThreadRuntime["targetKind"];
  readonly provider: ProjectionThreadRuntime["provider"];
  readonly role: ProjectionThreadRuntime["role"];
  readonly status: ProjectionThreadRuntime["status"];
  readonly updatedAt: string;
}): ProjectionThreadRuntime => ({
  threadId: input.threadId,
  targetKind: input.targetKind,
  provider: input.provider,
  role: input.role,
  runtimeInstanceId: null,
  status: input.status,
  rootPath: null,
  instance: null,
  processes: [],
  routes: [],
  snapshots: [],
  leases: [],
  lastActivityAt: null,
  updatedAt: input.updatedAt,
});

// Merge an entity into a summary array, replacing any existing entry by id.
export const upsertById = <T extends { readonly id: string }>(
  items: ReadonlyArray<T>,
  next: T,
): ReadonlyArray<T> => {
  const filtered = items.filter((item) => item.id !== next.id);
  return [...filtered, next];
};
