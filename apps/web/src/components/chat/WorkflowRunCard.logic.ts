// FILE: WorkflowRunCard.logic.ts
// Purpose: Derives the live workflow run panel (Claude dynamic workflows) from task
// activities: the workflow header plus one row per member agent with status, token,
// and elapsed-time snapshots. Rows are grouped by workflow run; the SDK does not
// carry the native CLI's phase grouping yet, so `phase` stays null until it does.
// Layer: Chat composer logic
// Exports: deriveWorkflowRunState, WorkflowRunState, and WorkflowAgentRow

import { ThreadId, type OrchestrationThreadActivity } from "@synara/contracts";

import { orderedActivities } from "../../session-logic";
import { formatSubagentModelLabel, type SubagentStatusKind } from "../../lib/subagentPresentation";

export interface WorkflowAgentRow {
  taskId: string;
  description: string;
  subagentType: string | null;
  // Reserved for the native CLI's phase grouping once the SDK carries it.
  phase: string | null;
  statusKind: SubagentStatusKind;
  statusLabel: string;
  totalTokens: number | null;
  // Last usage-reported duration; live rows fall back to wall clock since startedAt.
  durationMs: number | null;
  startedAt: string;
  threadId: ThreadId | null;
  modelLabel: string | undefined;
}

export interface WorkflowRunState {
  workflowTaskId: string;
  name: string;
  description: string | null;
  startedAt: string;
  runningCount: number;
  agents: WorkflowAgentRow[];
  // Workflow task id plus member ids, so callers can dedupe the generic
  // background-agent count against rows this panel already shows.
  taskIds: string[];
}

// Minimal identity a row needs to link into an existing subagent child thread.
export interface WorkflowSubagentThreadRef {
  threadId: string;
  model?: string | undefined;
}

interface TaskSnapshot {
  taskId: string;
  startedAt: string;
  description: string;
  taskType: string | null;
  subagentType: string | null;
  workflowName: string | null;
  workflowTaskId: string | null;
  toolUseId: string | null;
  status: "running" | "paused" | "completed" | "failed" | "stopped";
  totalTokens: number | null;
  durationMs: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readUsage(payload: Record<string, unknown>): {
  totalTokens: number | null;
  durationMs: number | null;
} {
  const usage = asRecord(payload.usage);
  return {
    totalTokens: usage && typeof usage.total_tokens === "number" ? usage.total_tokens : null,
    durationMs: usage && typeof usage.duration_ms === "number" ? usage.duration_ms : null,
  };
}

function completionStatus(status: string | null): TaskSnapshot["status"] {
  return status === "failed" ? "failed" : status === "stopped" ? "stopped" : "completed";
}

// Folds the task lifecycle activities into one snapshot per task id. Later
// activities win on status/usage; identity fields stick from task.started.
function collectTaskSnapshots(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Map<string, TaskSnapshot> {
  const snapshots = new Map<string, TaskSnapshot>();
  for (const activity of orderedActivities(activities)) {
    if (
      activity.kind !== "task.started" &&
      activity.kind !== "task.progress" &&
      activity.kind !== "task.updated" &&
      activity.kind !== "task.completed"
    ) {
      continue;
    }
    const payload = asRecord(activity.payload);
    const taskId = payload ? asString(payload.taskId) : null;
    if (!payload || !taskId) {
      continue;
    }

    if (activity.kind === "task.started") {
      snapshots.set(taskId, {
        taskId,
        startedAt: activity.createdAt,
        description: asString(payload.detail) ?? "Task",
        taskType: asString(payload.taskType),
        subagentType: asString(payload.subagentType),
        workflowName: asString(payload.workflowName),
        workflowTaskId: asString(payload.workflowTaskId),
        toolUseId: asString(payload.toolUseId),
        status: "running",
        totalTokens: null,
        durationMs: null,
      });
      continue;
    }

    const snapshot = snapshots.get(taskId);
    if (!snapshot) {
      continue;
    }

    if (activity.kind === "task.progress") {
      const usage = readUsage(payload);
      snapshot.totalTokens = usage.totalTokens ?? snapshot.totalTokens;
      snapshot.durationMs = usage.durationMs ?? snapshot.durationMs;
      continue;
    }

    if (activity.kind === "task.updated") {
      const status = asString(payload.status);
      if (status === "paused") {
        snapshot.status = "paused";
      } else if (status === "running" || status === "pending") {
        snapshot.status = "running";
      } else if (status === "killed") {
        snapshot.status = "stopped";
      } else if (status === "completed" || status === "failed") {
        snapshot.status = status;
      }
      continue;
    }

    snapshot.status = completionStatus(asString(payload.status));
    const usage = readUsage(payload);
    snapshot.totalTokens = usage.totalTokens ?? snapshot.totalTokens;
    snapshot.durationMs = usage.durationMs ?? snapshot.durationMs;
  }
  return snapshots;
}

function agentStatusPresentation(status: TaskSnapshot["status"]): {
  statusKind: SubagentStatusKind;
  statusLabel: string;
} {
  switch (status) {
    case "running":
      return { statusKind: "running", statusLabel: "Running" };
    case "paused":
      return { statusKind: "idle", statusLabel: "Paused" };
    case "completed":
      return { statusKind: "completed", statusLabel: "Completed" };
    case "failed":
      return { statusKind: "failed", statusLabel: "Failed" };
    case "stopped":
      return { statusKind: "stopped", statusLabel: "Stopped" };
  }
}

// Wall-clock fallback used by the card's ticking labels when usage has not
// reported a duration yet (or the row is still live).
export function workflowElapsedMs(
  row: Pick<WorkflowAgentRow, "durationMs" | "statusKind" | "startedAt">,
  nowMs: number,
): number | null {
  if (row.statusKind === "running" || row.statusKind === "idle") {
    const startedAtMs = Date.parse(row.startedAt);
    return Number.isNaN(startedAtMs) ? row.durationMs : Math.max(0, nowMs - startedAtMs);
  }
  return row.durationMs;
}

export function deriveWorkflowRunState(input: {
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  subagentThreadsByToolUseId?: ReadonlyMap<string, WorkflowSubagentThreadRef>;
}): WorkflowRunState | null {
  const snapshots = collectTaskSnapshots(input.activities);

  // The panel tracks the latest workflow run and retires once it settles,
  // mirroring how the subagent strip retires after its rows finish.
  const workflow = [...snapshots.values()].findLast(
    (snapshot) => snapshot.taskType === "local_workflow",
  );
  if (!workflow || (workflow.status !== "running" && workflow.status !== "paused")) {
    return null;
  }

  const agents = [...snapshots.values()]
    .filter((snapshot) => snapshot.workflowTaskId === workflow.taskId)
    .map((snapshot): WorkflowAgentRow => {
      const threadRef = snapshot.toolUseId
        ? input.subagentThreadsByToolUseId?.get(snapshot.toolUseId)
        : undefined;
      return {
        taskId: snapshot.taskId,
        description: snapshot.description,
        subagentType: snapshot.subagentType,
        phase: null,
        ...agentStatusPresentation(snapshot.status),
        totalTokens: snapshot.totalTokens,
        durationMs: snapshot.durationMs,
        startedAt: snapshot.startedAt,
        threadId: threadRef ? ThreadId.makeUnsafe(threadRef.threadId) : null,
        modelLabel: formatSubagentModelLabel(threadRef?.model),
      };
    });

  return {
    workflowTaskId: workflow.taskId,
    name: workflow.workflowName ?? workflow.description,
    description: workflow.workflowName ? workflow.description : null,
    startedAt: workflow.startedAt,
    runningCount: agents.filter((agent) => agent.statusKind === "running").length,
    agents,
    taskIds: [workflow.taskId, ...agents.map((agent) => agent.taskId)],
  };
}
