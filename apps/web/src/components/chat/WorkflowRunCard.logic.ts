// FILE: WorkflowRunCard.logic.ts
// Purpose: Derives the workflow run panel (Claude dynamic workflows) from task
// activities: the workflow header plus one row per member agent with status and
// elapsed-time snapshots. Workflow agents surface through the workflow task's own
// progress descriptions ("<phase>: <label>"); phases parsed from the script meta
// build the phase rail, and the persisted runId/scriptPath from the launch result
// drive pause/resume on settled runs.
// Layer: Chat composer logic
// Exports: deriveWorkflowRunState, WorkflowRunState, WorkflowAgentRow, and
// buildWorkflowResumePrompt

import { ThreadId, type OrchestrationThreadActivity } from "@synara/contracts";

import { orderedActivities } from "../../session-logic";
import { formatSubagentModelLabel, type SubagentStatusKind } from "../../lib/subagentPresentation";

export interface WorkflowAgentRow {
  taskId: string;
  description: string;
  subagentType: string | null;
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

export interface WorkflowPhaseSummary {
  title: string;
  detail: string | null;
  doneCount: number;
  totalCount: number;
  isCurrent: boolean;
}

export interface WorkflowRunState {
  workflowTaskId: string;
  name: string;
  description: string | null;
  startedAt: string;
  status: "running" | "paused" | "completed" | "failed" | "stopped";
  settled: boolean;
  // User hit Pause (vs. a plain stop): the settled card presents as paused.
  pausedByUser: boolean;
  // Persisted launch identifiers; both present means the run can be resumed.
  runId: string | null;
  scriptPath: string | null;
  // Null when no phase information was parsed: render the flat agent list.
  phases: WorkflowPhaseSummary[] | null;
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

// One composer turn re-invokes the Workflow tool against the persisted script;
// completed agent() calls replay from cache, so stop-then-resume behaves as pause.
export function buildWorkflowResumePrompt(scriptPath: string, runId: string): string {
  return `Resume the workflow by invoking the Workflow tool with {"scriptPath": ${JSON.stringify(scriptPath)}, "resumeFromRunId": ${JSON.stringify(runId)}}. Do not modify the script.`;
}

interface WorkflowProgressEntry {
  phase: string | null;
  label: string;
  at: string;
}

interface WorkflowFinalAgent {
  label: string;
  phaseIndex: number | null;
  model: string | null;
  state: string | null;
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
  phases: Array<{ title: string; detail: string | null }> | null;
  agentPhases: Record<string, string> | null;
  runId: string | null;
  scriptPath: string | null;
  progress: WorkflowProgressEntry[];
  finalAgents: WorkflowFinalAgent[] | null;
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

function readPhases(value: unknown): TaskSnapshot["phases"] {
  if (!Array.isArray(value)) {
    return null;
  }
  const phases = value.flatMap((entry) => {
    const record = asRecord(entry);
    const title = record ? asString(record.title) : null;
    return record && title ? [{ title, detail: asString(record.detail) }] : [];
  });
  return phases.length > 0 ? phases : null;
}

function readAgentPhases(value: unknown): Record<string, string> | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const pairs = Object.entries(record).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
  );
  return pairs.length > 0 ? Object.fromEntries(pairs) : null;
}

function readFinalAgents(value: unknown): WorkflowFinalAgent[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const agents = value.flatMap((entry) => {
    const record = asRecord(entry);
    const label = record ? asString(record.label) : null;
    if (!record || !label) {
      return [];
    }
    return [
      {
        label,
        phaseIndex: typeof record.phaseIndex === "number" ? record.phaseIndex : null,
        model: asString(record.model),
        state: asString(record.state),
      },
    ];
  });
  return agents.length > 0 ? agents : null;
}

// Workflow progress descriptions arrive as "<phase title>: <agent label>"; a
// description without the separator is treated as a bare label.
function parseProgressDescription(description: string): Omit<WorkflowProgressEntry, "at"> | null {
  const separator = description.indexOf(": ");
  const phase = separator > 0 ? description.slice(0, separator).trim() : null;
  const label = (separator > 0 ? description.slice(separator + 2) : description).trim();
  return label.length > 0 ? { phase: phase && phase.length > 0 ? phase : null, label } : null;
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
        phases: readPhases(payload.workflowPhases),
        agentPhases: readAgentPhases(payload.workflowAgentPhases),
        runId: null,
        scriptPath: null,
        progress: [],
        finalAgents: null,
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
      if (snapshot.taskType === "local_workflow") {
        const description = asString(payload.description) ?? asString(payload.detail);
        const entry = description ? parseProgressDescription(description) : null;
        if (entry) {
          snapshot.progress.push({ ...entry, at: activity.createdAt });
        }
      }
      continue;
    }

    if (activity.kind === "task.updated") {
      snapshot.runId = asString(payload.workflowRunId) ?? snapshot.runId;
      snapshot.scriptPath = asString(payload.workflowScriptPath) ?? snapshot.scriptPath;
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
    snapshot.finalAgents = readFinalAgents(payload.workflowAgents) ?? snapshot.finalAgents;
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

function isSettledStatusKind(statusKind: SubagentStatusKind): boolean {
  return statusKind === "completed" || statusKind === "failed" || statusKind === "stopped";
}

function finalAgentStatus(
  state: string | null,
  workflowStatus: TaskSnapshot["status"],
): TaskSnapshot["status"] {
  switch (state) {
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "killed":
    case "stopped":
      return "stopped";
    default:
      return workflowStatus === "running" || workflowStatus === "paused"
        ? "completed"
        : workflowStatus;
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

const OTHER_PHASE_TITLE = "Other";

export function deriveWorkflowRunState(input: {
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  subagentThreadsByToolUseId?: ReadonlyMap<string, WorkflowSubagentThreadRef>;
  // Transient client flags keyed by workflow task id (not persisted server-side).
  pausedByUserTaskIds?: ReadonlySet<string>;
  dismissedTaskIds?: ReadonlySet<string>;
}): WorkflowRunState | null {
  const snapshots = collectTaskSnapshots(input.activities);

  // The panel tracks the latest workflow run. Settled runs stay visible while
  // they can still be resumed (or were paused by the user) until dismissed.
  const workflow = [...snapshots.values()].findLast(
    (snapshot) => snapshot.taskType === "local_workflow",
  );
  if (!workflow) {
    return null;
  }
  const settled = workflow.status !== "running" && workflow.status !== "paused";
  const pausedByUser =
    workflow.status === "stopped" && (input.pausedByUserTaskIds?.has(workflow.taskId) ?? false);
  const canResume = workflow.runId !== null && workflow.scriptPath !== null;
  if (settled && (input.dismissedTaskIds?.has(workflow.taskId) || (!pausedByUser && !canResume))) {
    return null;
  }

  // Script-parsed label -> phase pairs; only a fallback for member-task rows,
  // since live placement comes from the progress descriptions.
  const phaseForLabel = (label: string): string | null => {
    if (!workflow.agentPhases) {
      return null;
    }
    const exact = workflow.agentPhases[label];
    if (exact) {
      return exact;
    }
    const lower = label.toLowerCase();
    const match = Object.entries(workflow.agentPhases).find(
      ([candidate]) => candidate.toLowerCase() === lower,
    );
    return match ? match[1] : null;
  };

  // Progress phase titles are normalized onto the meta phase list so casing
  // differences cannot split a phase into two rail entries.
  const canonicalPhase = (phase: string | null): string | null => {
    if (phase === null) {
      return null;
    }
    const lower = phase.toLowerCase();
    return workflow.phases?.find((entry) => entry.title.toLowerCase() === lower)?.title ?? phase;
  };

  // Member-task rows: plain background tasks tagged onto the run. Workflow
  // agents themselves emit no task events, so these are usually empty.
  const memberSnapshots = [...snapshots.values()].filter(
    (snapshot) => snapshot.workflowTaskId === workflow.taskId,
  );
  let lastMatchedPhase: string | null = null;
  const memberRows = memberSnapshots.map((snapshot): WorkflowAgentRow => {
    const matched = canonicalPhase(phaseForLabel(snapshot.description));
    if (matched !== null) {
      lastMatchedPhase = matched;
    }
    const threadRef = snapshot.toolUseId
      ? input.subagentThreadsByToolUseId?.get(snapshot.toolUseId)
      : undefined;
    return {
      taskId: snapshot.taskId,
      description: snapshot.description,
      subagentType: snapshot.subagentType,
      phase: matched ?? lastMatchedPhase,
      ...agentStatusPresentation(snapshot.status),
      totalTokens: snapshot.totalTokens,
      durationMs: snapshot.durationMs,
      startedAt: snapshot.startedAt,
      threadId: threadRef ? ThreadId.makeUnsafe(threadRef.threadId) : null,
      modelLabel: formatSubagentModelLabel(threadRef?.model),
    };
  });

  // Progress rows: one per distinct label from the workflow's own progress
  // events; the latest entry decides the run's current phase.
  const progressByLabel = new Map<string, { phase: string | null; firstAt: string }>();
  for (const entry of workflow.progress) {
    const existing = progressByLabel.get(entry.label);
    progressByLabel.set(entry.label, {
      phase: canonicalPhase(entry.phase) ?? existing?.phase ?? null,
      firstAt: existing?.firstAt ?? entry.at,
    });
  }
  const latestEntry = workflow.progress.at(-1);
  const latestPhase = latestEntry ? canonicalPhase(latestEntry.phase) : null;
  const finalAgentByLabel = new Map(
    (workflow.finalAgents ?? []).map((agent) => [agent.label.toLowerCase(), agent]),
  );
  const memberDescriptions = new Set(memberRows.map((row) => row.description.toLowerCase()));
  const progressRows = [...progressByLabel.entries()]
    .filter(([label]) => !memberDescriptions.has(label.toLowerCase()))
    .map(([label, entry]): WorkflowAgentRow => {
      const finalAgent = finalAgentByLabel.get(label.toLowerCase());
      const phase =
        entry.phase ??
        (finalAgent && finalAgent.phaseIndex !== null
          ? (workflow.phases?.[finalAgent.phaseIndex]?.title ?? null)
          : null) ??
        canonicalPhase(phaseForLabel(label));
      const status: TaskSnapshot["status"] = settled
        ? finalAgentStatus(finalAgent?.state ?? null, workflow.status)
        : (phase !== null && phase === latestPhase) || label === latestEntry?.label
          ? "running"
          : "completed";
      return {
        taskId: `${workflow.taskId}:agent:${label}`,
        description: label,
        subagentType: null,
        phase,
        ...agentStatusPresentation(status),
        totalTokens: null,
        durationMs: null,
        startedAt: entry.firstAt,
        threadId: null,
        modelLabel: formatSubagentModelLabel(finalAgent?.model ?? undefined),
      };
    });

  // Settled runs backfill agents the live stream never mentioned (e.g. a phase
  // that finished between progress ticks) from the final progress file.
  const seenLabels = new Set(
    [...progressRows, ...memberRows].map((row) => row.description.toLowerCase()),
  );
  const backfilledRows = settled
    ? (workflow.finalAgents ?? [])
        .filter((agent) => !seenLabels.has(agent.label.toLowerCase()))
        .map(
          (agent): WorkflowAgentRow => ({
            taskId: `${workflow.taskId}:agent:${agent.label}`,
            description: agent.label,
            subagentType: null,
            phase:
              (agent.phaseIndex !== null
                ? (workflow.phases?.[agent.phaseIndex]?.title ?? null)
                : null) ?? canonicalPhase(phaseForLabel(agent.label)),
            ...agentStatusPresentation(finalAgentStatus(agent.state, workflow.status)),
            totalTokens: null,
            durationMs: null,
            startedAt: workflow.startedAt,
            threadId: null,
            modelLabel: formatSubagentModelLabel(agent.model ?? undefined),
          }),
        )
    : [];

  const agents = [...memberRows, ...progressRows, ...backfilledRows];

  // Once any phase information exists, unplaced rows land in a trailing "Other"
  // bucket; with none at all every phase stays null and the flat phase-less
  // rendering is preserved.
  if (workflow.phases !== null || agents.some((row) => row.phase !== null)) {
    for (const row of agents) {
      row.phase ??= OTHER_PHASE_TITLE;
    }
  }

  // Phase rail: meta phases in declared order, then phases only seen live, with
  // the "Other" bucket trailing.
  const orderedPhases: Array<{ title: string; detail: string | null }> = [
    ...(workflow.phases ?? []),
  ];
  for (const row of agents) {
    if (
      row.phase !== null &&
      row.phase !== OTHER_PHASE_TITLE &&
      !orderedPhases.some((phase) => phase.title === row.phase)
    ) {
      orderedPhases.push({ title: row.phase, detail: null });
    }
  }
  if (agents.some((row) => row.phase === OTHER_PHASE_TITLE)) {
    orderedPhases.push({ title: OTHER_PHASE_TITLE, detail: null });
  }

  let phases: WorkflowPhaseSummary[] | null = null;
  if (orderedPhases.length > 0) {
    phases = orderedPhases.map((phase) => {
      const rows = agents.filter((row) => row.phase === phase.title);
      return {
        title: phase.title,
        detail: phase.detail,
        doneCount: rows.filter((row) => isSettledStatusKind(row.statusKind)).length,
        totalCount: rows.length,
        isCurrent: false,
      };
    });
    const current =
      phases.find((phase) => phase.doneCount < phase.totalCount) ??
      phases.findLast((phase) => phase.totalCount > 0) ??
      (settled ? undefined : phases[0]);
    if (current) {
      current.isCurrent = true;
    }
  }

  return {
    workflowTaskId: workflow.taskId,
    name: workflow.workflowName ?? workflow.description,
    description: workflow.workflowName ? workflow.description : null,
    startedAt: workflow.startedAt,
    status: workflow.status,
    settled,
    pausedByUser,
    runId: workflow.runId,
    scriptPath: workflow.scriptPath,
    phases,
    runningCount: agents.filter((agent) => agent.statusKind === "running").length,
    agents,
    taskIds: [workflow.taskId, ...memberRows.map((agent) => agent.taskId)],
  };
}
