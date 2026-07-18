import {
  ApprovalRequestId,
  type CompanionActivity,
  type CompanionApprovalRequest,
  type CompanionMessage,
  type CompanionProject,
  type CompanionShellSnapshot,
  type CompanionThreadDetail,
  type CompanionThreadSummary,
  type CompanionUserInputRequest,
  type OrchestrationProjectShell,
  type OrchestrationMessage,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type UserInputQuestion,
} from "@synara/contracts";

import { sanitizeCompanionDiagnostic } from "./sanitize";

const SAFE_ERROR_MAX_CHARS = 500;

function safeNonEmpty(value: string | null | undefined, maxChars: number): string | null {
  return sanitizeCompanionDiagnostic(value, maxChars);
}

export function toCompanionProject(project: OrchestrationProjectShell): CompanionProject {
  return {
    id: project.id,
    kind: project.kind ?? "project",
    title: project.title,
    defaultModelSelection: project.defaultModelSelection,
    isPinned: project.isPinned ?? false,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function toCompanionMessage(message: OrchestrationMessage): CompanionMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    ...(message.attachments ? { attachments: message.attachments } : {}),
    ...(message.dispatchMode ? { dispatchMode: message.dispatchMode } : {}),
    ...(message.dispatchOrigin ? { dispatchOrigin: message.dispatchOrigin } : {}),
    turnId: message.turnId,
    streaming: message.streaming,
    source: message.source,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

export function toCompanionThreadSummary(
  thread: OrchestrationThreadShell | OrchestrationThread,
): CompanionThreadSummary {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    latestTurn: thread.latestTurn,
    runtime: thread.session
      ? {
          status: thread.session.status,
          activeTurnId: thread.session.activeTurnId,
          lastError: safeNonEmpty(thread.session.lastError, SAFE_ERROR_MAX_CHARS),
          updatedAt: thread.session.updatedAt,
        }
      : null,
    hasPendingApprovals: thread.hasPendingApprovals === true,
    hasPendingUserInput: thread.hasPendingUserInput === true,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt ?? null,
  };
}

export function toCompanionActivity(activity: OrchestrationThreadActivity): CompanionActivity {
  return {
    id: activity.id,
    tone: activity.tone,
    kind: activity.kind,
    summary: safeNonEmpty(activity.summary, 1_000) ?? "Activity",
    turnId: activity.turnId,
    sequence: activity.sequence ?? 0,
    createdAt: activity.createdAt,
  };
}

function payloadRecord(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return activity.payload !== null && typeof activity.payload === "object"
    ? (activity.payload as Record<string, unknown>)
    : null;
}

function requestKindFromPayload(payload: Record<string, unknown> | null) {
  const kind = payload?.requestKind;
  if (kind === "command" || kind === "file-read" || kind === "file-change") return kind;
  switch (payload?.requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command" as const;
    case "file_read_approval":
      return "file-read" as const;
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change" as const;
    default:
      return null;
  }
}

function isStaleFailure(payload: Record<string, unknown> | null): boolean {
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : "";
  return detail.includes("stale pending") || detail.includes("unknown pending");
}

function orderedActivities(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  return [...activities].sort(
    (left, right) =>
      (left.sequence ?? Number.MAX_SAFE_INTEGER) -
        (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
      left.createdAt.localeCompare(right.createdAt),
  );
}

function parseQuestions(payload: Record<string, unknown> | null): UserInputQuestion[] | null {
  if (!Array.isArray(payload?.questions)) return null;
  const questions = payload.questions
    .slice(0, 3)
    .map((entry): UserInputQuestion | null => {
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
      const options = question.options.flatMap((option) => {
        if (!option || typeof option !== "object") return [];
        const value = option as Record<string, unknown>;
        if (typeof value.label !== "string" || typeof value.description !== "string") return [];
        const label = safeNonEmpty(value.label, 200);
        const description = safeNonEmpty(value.description, 1_000);
        return label && description ? [{ label, description }] : [];
      });
      const header = safeNonEmpty(question.header, 200);
      const prompt = safeNonEmpty(question.question, 2_000);
      if (!header || !prompt) return null;
      return {
        id: question.id,
        header,
        question: prompt,
        options,
        ...(question.multiSelect === true ? { multiSelect: true as const } : {}),
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return questions.length > 0 ? questions : null;
}

export function deriveCompanionApprovals(
  threadId: OrchestrationThread["id"],
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): CompanionApprovalRequest[] {
  const open = new Map<string, CompanionApprovalRequest>();
  for (const activity of orderedActivities(activities)) {
    const payload = payloadRecord(activity);
    const rawRequestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (!rawRequestId) continue;
    const requestId = ApprovalRequestId.makeUnsafe(rawRequestId);
    if (activity.kind === "approval.requested") {
      const requestKind = requestKindFromPayload(payload);
      if (!requestKind) continue;
      open.set(rawRequestId, {
        requestId,
        threadId,
        turnId: activity.turnId,
        requestKind,
        summary: safeNonEmpty(activity.summary, 1_000) ?? "Approval required",
        createdAt: activity.createdAt,
      });
    } else if (
      activity.kind === "approval.resolved" ||
      (activity.kind === "provider.approval.respond.failed" && isStaleFailure(payload))
    ) {
      open.delete(rawRequestId);
    }
  }
  return [...open.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function deriveCompanionUserInputRequests(
  threadId: OrchestrationThread["id"],
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): CompanionUserInputRequest[] {
  const open = new Map<string, CompanionUserInputRequest>();
  for (const activity of orderedActivities(activities)) {
    const payload = payloadRecord(activity);
    const rawRequestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (!rawRequestId) continue;
    const requestId = ApprovalRequestId.makeUnsafe(rawRequestId);
    if (activity.kind === "user-input.requested") {
      const questions = parseQuestions(payload);
      if (!questions) continue;
      open.set(rawRequestId, {
        requestId,
        threadId,
        turnId: activity.turnId,
        questions,
        createdAt: activity.createdAt,
      });
    } else if (
      activity.kind === "user-input.resolved" ||
      (activity.kind === "provider.user-input.respond.failed" && isStaleFailure(payload))
    ) {
      open.delete(rawRequestId);
    }
  }
  return [...open.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function toCompanionThreadDetail(thread: OrchestrationThread): CompanionThreadDetail {
  return {
    thread: toCompanionThreadSummary(thread),
    messages: thread.messages.map(toCompanionMessage),
    activities: thread.activities.map(toCompanionActivity),
    proposedPlans: thread.proposedPlans,
    approvals: deriveCompanionApprovals(thread.id, thread.activities),
    userInputRequests: deriveCompanionUserInputRequests(thread.id, thread.activities),
  };
}

export function toCompanionShellSnapshot(
  snapshot: OrchestrationShellSnapshot,
): CompanionShellSnapshot {
  return {
    snapshotSequence: snapshot.snapshotSequence,
    projects: snapshot.projects.map(toCompanionProject),
    threads: snapshot.threads.map(toCompanionThreadSummary),
    updatedAt: snapshot.updatedAt,
  };
}
