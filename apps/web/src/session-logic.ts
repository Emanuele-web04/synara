// Purpose: Session-level derivations (turn timing, task lists, background work, phase) plus the
//   stable public surface that re-exports the pending/plan/work-log/timeline group modules.
// Layer: web pure logic (no React, no I/O).
// Exports: see re-exports below plus the timing/task/phase derivations defined here.
import {
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type ProviderKind,
  type TurnId,
} from "@t3tools/contracts";

import { compareActivitiesByOrder } from "./session-logic.shared";
import type { ChatMessage, SessionPhase, Thread, ThreadSession, TurnDiffSummary } from "./types";

export type { PendingApproval, PendingUserInput } from "./session-logic.pending";
export { derivePendingApprovals, derivePendingUserInputs } from "./session-logic.pending";

export type { LatestProposedPlanState } from "./session-logic.plan";
export {
  buildSourceProposedPlanReference,
  findLatestProposedPlan,
  findSidebarProposedPlan,
  hasActionableProposedPlan,
} from "./session-logic.plan";

export type { WorkLogEntry, WorkLogSubagent, WorkLogSubagentAction } from "./session-logic.workLog";
export {
  WORK_LOG_PRESENTATION_VERSION,
  deriveWorkLogEntries,
  formatWorkLogEntryLabel,
  formatWorkLogEntryDetail,
  isFileChangeWorkLogEntry,
  isProviderFileEditWorkLogEntry,
} from "./session-logic.workLog";

export type { CompactChatTimelineEntry, TimelineEntry } from "./session-logic.timeline";
export { deriveCompactChatTimelineEntries, deriveTimelineEntries } from "./session-logic.timeline";

export type {
  DeriveTranscriptComposerStateInput,
  DeriveTranscriptRowsInput,
  TranscriptComposerBlockerKind,
  TranscriptComposerState,
  TranscriptRow,
  TranscriptRowKind,
  TranscriptRowSource,
} from "./session-logic.transcript";
export {
  TRANSCRIPT_COMPOSER_BLOCKER_PRIORITY,
  TRANSCRIPT_STATE_TABLE,
  deriveTranscriptComposerState,
  deriveTranscriptRows,
} from "./session-logic.transcript";

export type ProviderPickerKind = ProviderKind;

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
}> = [
  { value: "codex", label: "Codex", available: true },
  { value: "claudeAgent", label: "Claude", available: true },
  { value: "cursor", label: "Cursor", available: true },
  { value: "gemini", label: "Gemini", available: true },
  { value: "grok", label: "Grok", available: true },
  { value: "kilo", label: "Kilo", available: true },
  { value: "opencode", label: "OpenCode", available: true },
  { value: "pi", label: "Pi", available: true },
];

export function canSessionAnswerPendingRequests(
  session: Pick<ThreadSession, "status"> | null | undefined,
): boolean {
  if (!session) {
    return true;
  }
  return session.status !== "closed" && session.status !== "error";
}

export function isSessionRunningTurn(
  session: Pick<ThreadSession, "orchestrationStatus" | "status"> | null | undefined,
): boolean {
  if (!session) {
    return false;
  }
  return session.orchestrationStatus === "running" || session.status === "running";
}

export function isThreadRunningTurn(thread: Pick<Thread, "session"> | null | undefined): boolean {
  return isSessionRunningTurn(thread?.session);
}

export interface ActiveTaskListState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  tasks: Array<{
    task: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

export interface ActiveBackgroundTasksState {
  activeCount: number;
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

export function formatClockDuration(durationMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatClockElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatClockDuration(endedAt - startedAt);
}

type LatestTurnTiming = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
>;
type SessionActivityState = Pick<ThreadSession, "orchestrationStatus" | "activeTurnId">;

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (latestTurn.state === "interrupted" || latestTurn.state === "error") {
    return true;
  }
  if (!session) return true;
  if (session.orchestrationStatus === "running") return false;
  return true;
}

export function hasLiveLatestTurn(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) {
    return false;
  }
  return !isLatestTurnSettled(latestTurn, session);
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  const runningTurnId =
    session?.orchestrationStatus === "running" ? (session.activeTurnId ?? null) : null;
  if (runningTurnId !== null && runningTurnId === latestTurn?.turnId) {
    return latestTurn?.startedAt ?? sendStartedAt;
  }
  if (runningTurnId !== null) {
    return sendStartedAt;
  }
  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.startedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}

function toActiveTaskListState(activity: OrchestrationThreadActivity): ActiveTaskListState | null {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const rawTasks = payload?.tasks;
  if (!Array.isArray(rawTasks)) {
    return null;
  }
  const tasks = rawTasks
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.task !== "string") {
        return null;
      }
      const status =
        record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
      return {
        task: record.task,
        status,
      };
    })
    .filter(
      (
        task,
      ): task is {
        task: string;
        status: "pending" | "inProgress" | "completed";
      } => task !== null,
    );
  if (tasks.length === 0) {
    return null;
  }
  return {
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    ...(payload && "explanation" in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    tasks,
  };
}

export function deriveActiveTaskListState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActiveTaskListState | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const allTaskListActivities = ordered.filter(
    (activity) => activity.kind === "turn.tasks.updated",
  );
  const settledTurnIds = new Set<TurnId>();

  // A prior-turn task list only stays visible while that originating turn is still unresolved.
  for (const activity of ordered) {
    if (!activity.turnId) {
      continue;
    }
    if (activity.kind === "turn.completed" || activity.kind === "turn.aborted") {
      settledTurnIds.add(activity.turnId);
    }
  }

  const currentTurnTaskList = latestTurnId
    ? (allTaskListActivities
        .filter((activity) => activity.turnId === latestTurnId)
        .map(toActiveTaskListState)
        .findLast((taskList) => taskList !== null) ?? null)
    : null;
  if (currentTurnTaskList) {
    return currentTurnTaskList;
  }

  // Keep the most recent unfinished prior task list visible so implementation turns
  // that have started but not emitted their own task update can still show progress.
  const latestPriorTaskList =
    allTaskListActivities.map(toActiveTaskListState).findLast((taskList) => taskList !== null) ??
    null;
  if (!latestPriorTaskList) {
    return null;
  }

  if (latestPriorTaskList.turnId && settledTurnIds.has(latestPriorTaskList.turnId)) {
    return null;
  }

  return latestPriorTaskList.tasks.some((task) => task.status !== "completed")
    ? latestPriorTaskList
    : null;
}

// Counts still-running background work for the active turn so compact UI can surface agent activity.
export function deriveActiveBackgroundTasksState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActiveBackgroundTasksState | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const activeTasks = new Map<string, { taskType?: string | undefined }>();

  for (const activity of ordered) {
    if (
      latestTurnId &&
      activity.turnId &&
      activity.turnId !== latestTurnId &&
      activity.kind !== "task.completed"
    ) {
      continue;
    }

    if (
      activity.kind !== "task.started" &&
      activity.kind !== "task.progress" &&
      activity.kind !== "task.completed"
    ) {
      continue;
    }

    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const taskId = payload && typeof payload.taskId === "string" ? payload.taskId : null;
    if (!taskId) {
      continue;
    }

    if (activity.kind === "task.completed") {
      activeTasks.delete(taskId);
      continue;
    }

    const previous = activeTasks.get(taskId);
    const taskType = payload && typeof payload.taskType === "string" ? payload.taskType : undefined;
    activeTasks.set(taskId, {
      taskType: taskType ?? previous?.taskType,
    });
  }

  const activeCount = [...activeTasks.values()].filter((task) => task.taskType !== "plan").length;
  return activeCount > 0 ? { activeCount } : null;
}

// Keeps the UI "working" while the provider still has visible assistant text or
// background-task updates to finish for the latest turn.
export function hasLiveTurnTailWork(input: {
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "completedAt"> | null;
  messages: ReadonlyArray<Pick<ChatMessage, "role" | "streaming" | "turnId">>;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  session?: Pick<ThreadSession, "orchestrationStatus"> | null;
}): boolean {
  const latestTurnId = input.latestTurn?.turnId;
  if (!latestTurnId) {
    return false;
  }

  const hasStreamingAssistantText = input.messages.some(
    (message) =>
      message.role === "assistant" && message.turnId === latestTurnId && message.streaming,
  );
  if (hasStreamingAssistantText) {
    // Once the turn is terminal, a stale `streaming` flag should not keep the
    // stop button/timer alive indefinitely.
    return input.latestTurn?.completedAt == null;
  }

  // Some providers can leave task lifecycle bookkeeping behind after the turn
  // has already closed. Once the session is no longer running, those stale
  // task rows should not keep the whole chat in a live state.
  if (input.session?.orchestrationStatus !== "running") {
    return false;
  }

  if (deriveActiveBackgroundTasksState(input.activities, latestTurnId) !== null) {
    return true;
  }

  return false;
}

export function inferCheckpointTurnCountByTurnId(
  summaries: TurnDiffSummary[],
): Record<TurnId, number> {
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<TurnId, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}
