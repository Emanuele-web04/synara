// FILE: WorkflowRunCard.logic.ts
// Purpose: Derives the workflow run panel (Claude dynamic workflows) from task
// activities: the workflow header plus one row per member agent with status and
// elapsed-time snapshots. Workflow agents surface through the workflow task's own
// progress descriptions ("<phase>: <label>"); phases parsed from the script meta
// build the phase rail, and the persisted runId/scriptPath from the launch result
// drive pause/resume on settled runs.
// Layer: Chat composer logic
// Exports: deriveWorkflowRunState, WorkflowRunState, WorkflowAgentRow,
// resolveWorkflowSelectedPhaseTitle, workflowElapsedMs, and
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
  toolCalls: number | null;
  // Last usage-reported duration; live rows fall back to wall clock since startedAt.
  durationMs: number | null;
  startedAt: string;
  threadId: ThreadId | null;
  // Raw model id (live transcript > final snapshot > planned script opts).
  model: string | null;
  modelLabel: string | undefined;
  // Reasoning effort, same precedence as model (live transcript > final
  // snapshot > planned script opts).
  effortLabel: string | null;
  promptPreview: string | null;
  recentToolNames: string[];
  lastToolName: string | null;
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
  effort?: string | undefined;
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
  phaseTitle: string | null;
  model: string | null;
  effort: string | null;
  state: string | null;
  tokens: number | null;
  toolCalls: number | null;
  durationMs: number | null;
  lastToolName: string | null;
  promptPreview: string | null;
}

// Live per-agent snapshot from the server's transcript-directory poller.
interface WorkflowLiveAgent {
  agentId: string;
  label: string | null;
  model: string | null;
  effort: string | null;
  state: "running" | "completed" | null;
  tokens: number | null;
  toolCalls: number | null;
  recentToolNames: string[];
  promptPreview: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
}

interface WorkflowAgentPlanEntry {
  phase: string | null;
  model: string | null;
  effort: string | null;
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
  agentPlans: Record<string, WorkflowAgentPlanEntry> | null;
  runId: string | null;
  scriptPath: string | null;
  progress: WorkflowProgressEntry[];
  liveAgents: WorkflowLiveAgent[] | null;
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

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readAgentPlans(value: unknown): Record<string, WorkflowAgentPlanEntry> | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const entries = Object.entries(record).flatMap(
    ([label, plan]): Array<[string, WorkflowAgentPlanEntry]> => {
      const planRecord = asRecord(plan);
      if (!planRecord) {
        return [];
      }
      const parsed: WorkflowAgentPlanEntry = {
        phase: asString(planRecord.phase),
        model: asString(planRecord.model),
        effort: asString(planRecord.effort),
      };
      return parsed.phase || parsed.model || parsed.effort ? [[label, parsed]] : [];
    },
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
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
        phaseTitle: asString(record.phaseTitle),
        model: asString(record.model),
        effort: asString(record.effort),
        state: asString(record.state),
        tokens: asFiniteNumber(record.tokens),
        toolCalls: asFiniteNumber(record.toolCalls),
        durationMs: asFiniteNumber(record.durationMs),
        lastToolName: asString(record.lastToolName),
        promptPreview: asString(record.promptPreview),
      },
    ];
  });
  return agents.length > 0 ? agents : null;
}

function readLiveAgents(value: unknown): WorkflowLiveAgent[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const agents = value.flatMap((entry): Array<WorkflowLiveAgent> => {
    const record = asRecord(entry);
    const agentId = record ? asString(record.agentId) : null;
    if (!record || !agentId) {
      return [];
    }
    const state = asString(record.state);
    return [
      {
        agentId,
        label: asString(record.label),
        model: asString(record.model),
        effort: asString(record.effort),
        state: state === "running" || state === "completed" ? state : null,
        tokens: asFiniteNumber(record.tokens),
        toolCalls: asFiniteNumber(record.toolCalls),
        recentToolNames: Array.isArray(record.recentToolNames)
          ? record.recentToolNames.filter(
              (name): name is string => typeof name === "string" && name.length > 0,
            )
          : [],
        promptPreview: asString(record.promptPreview),
        startedAt: asString(record.startedAt),
        lastActivityAt: asString(record.lastActivityAt),
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
        agentPlans: readAgentPlans(payload.workflowAgentPlans),
        runId: null,
        scriptPath: null,
        progress: [],
        liveAgents: null,
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
      // Poller-emitted snapshot events: their description is synthetic, not a
      // "<phase>: <label>" progress entry.
      const liveAgents = readLiveAgents(payload.workflowAgents);
      if (liveAgents) {
        snapshot.liveAgents = liveAgents;
        continue;
      }
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

// Duration for settled live snapshots; running rows return null so the card's
// ticking wall clock takes over.
function liveDurationMs(agent: WorkflowLiveAgent | null | undefined): number | null {
  if (!agent || agent.state !== "completed" || !agent.startedAt || !agent.lastActivityAt) {
    return null;
  }
  const startedMs = Date.parse(agent.startedAt);
  const lastMs = Date.parse(agent.lastActivityAt);
  return Number.isNaN(startedMs) || Number.isNaN(lastMs) ? null : Math.max(0, lastMs - startedMs);
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

// Phase-rail selection: the rail follows the run's current phase until the
// user clicks one; the manual choice sticks while the current phase it was
// made under is unchanged, then the rail snaps back to auto-follow.
export interface WorkflowPhaseSelection {
  title: string;
  // Current phase title at the moment the user clicked (null when none).
  currentTitleAtSelect: string | null;
}

export function resolveWorkflowSelectedPhaseTitle(
  phases: ReadonlyArray<WorkflowPhaseSummary> | null,
  manual: WorkflowPhaseSelection | null,
): string | null {
  if (!phases || phases.length === 0) {
    return null;
  }
  const current = phases.find((phase) => phase.isCurrent)?.title ?? null;
  if (
    manual &&
    manual.currentTitleAtSelect === current &&
    phases.some((phase) => phase.title === manual.title)
  ) {
    return manual.title;
  }
  return current ?? phases[0]!.title;
}

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
  const settled = workflow.status !== "running";
  const pausedByUser =
    workflow.status === "stopped" && (input.pausedByUserTaskIds?.has(workflow.taskId) ?? false);
  const canResume = workflow.runId !== null && workflow.scriptPath !== null;
  if (settled && (input.dismissedTaskIds?.has(workflow.taskId) || (!pausedByUser && !canResume))) {
    return null;
  }

  // Script-parsed label -> planned opts; a fallback for phase placement and the
  // only source for planned model/effort before live data arrives.
  const planForLabel = (label: string): WorkflowAgentPlanEntry | null => {
    const plans = workflow.agentPlans;
    if (!plans) {
      return null;
    }
    const exact = plans[label];
    if (exact) {
      return exact;
    }
    const lower = label.toLowerCase();
    const match = Object.entries(plans).find(([candidate]) => candidate.toLowerCase() === lower);
    return match ? match[1] : null;
  };

  // Script-parsed label -> phase pairs; only a fallback for placing rows when
  // live progress carries no phase.
  const phaseForLabel = (label: string): string | null => {
    const planned = planForLabel(label)?.phase;
    if (planned) {
      return planned;
    }
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
  // Ambient shell tasks (every Bash call surfaces as a local_bash task) are
  // not agents, and Task-tool subagents already render in the subagent strip;
  // drop both here too so already-persisted runs render clean.
  const memberSnapshots = [...snapshots.values()].filter(
    (snapshot) =>
      snapshot.workflowTaskId === workflow.taskId &&
      snapshot.taskType !== "local_bash" &&
      !(snapshot.toolUseId !== null && snapshot.subagentType !== null),
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
    const { statusKind, statusLabel } = agentStatusPresentation(snapshot.status);
    const plan = planForLabel(snapshot.description);
    const model = threadRef?.model ?? plan?.model ?? null;
    return {
      taskId: snapshot.taskId,
      description: snapshot.description,
      subagentType: snapshot.subagentType,
      phase: matched ?? lastMatchedPhase,
      statusKind,
      statusLabel,
      totalTokens: snapshot.totalTokens,
      toolCalls: null,
      durationMs: snapshot.durationMs,
      startedAt: snapshot.startedAt,
      threadId: threadRef ? ThreadId.makeUnsafe(threadRef.threadId) : null,
      model,
      modelLabel: formatSubagentModelLabel(model),
      effortLabel: threadRef?.effort ?? plan?.effort ?? null,
      promptPreview: null,
      recentToolNames: [],
      lastToolName: null,
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
  const finalAgentPhase = (agent: WorkflowFinalAgent): string | null =>
    canonicalPhase(agent.phaseTitle) ??
    (agent.phaseIndex !== null ? (workflow.phases?.[agent.phaseIndex - 1]?.title ?? null) : null);
  // Live snapshots join by label when the server zipped one on; unlabeled
  // snapshots fall back to first-seen order (progress labels arrive in agent
  // start order, the same order journal starts are recorded in).
  const liveAgents = workflow.liveAgents ?? [];
  const liveByLabel = new Map(
    liveAgents.flatMap(
      (agent): Array<[string, WorkflowLiveAgent]> =>
        agent.label ? [[agent.label.toLowerCase(), agent]] : [],
    ),
  );
  const claimedLiveAgents = new Set<WorkflowLiveAgent>();
  const orderedLabels = [...progressByLabel.keys()];
  const liveForLabel = (label: string): WorkflowLiveAgent | undefined => {
    const byLabel = liveByLabel.get(label.toLowerCase());
    if (byLabel) {
      claimedLiveAgents.add(byLabel);
      return byLabel;
    }
    const index = orderedLabels.indexOf(label);
    const byOrder = index >= 0 ? liveAgents[index] : undefined;
    if (byOrder && !byOrder.label && !claimedLiveAgents.has(byOrder)) {
      claimedLiveAgents.add(byOrder);
      return byOrder;
    }
    return undefined;
  };
  const memberDescriptions = new Set(memberRows.map((row) => row.description.toLowerCase()));
  const progressRows = [...progressByLabel.entries()]
    .filter(([label]) => !memberDescriptions.has(label.toLowerCase()))
    .map(([label, entry]): WorkflowAgentRow => {
      const finalAgent = finalAgentByLabel.get(label.toLowerCase());
      const live = liveForLabel(label);
      const plan = planForLabel(label);
      const phase =
        entry.phase ??
        (finalAgent ? finalAgentPhase(finalAgent) : null) ??
        canonicalPhase(phaseForLabel(label));
      const status: TaskSnapshot["status"] = settled
        ? finalAgentStatus(finalAgent?.state ?? null, workflow.status)
        : live?.state === "completed"
          ? "completed"
          : live?.state === "running"
            ? "running"
            : (phase !== null && phase === latestPhase) || label === latestEntry?.label
              ? "running"
              : "completed";
      const { statusKind, statusLabel } = agentStatusPresentation(status);
      const model = live?.model ?? finalAgent?.model ?? plan?.model ?? null;
      const effort = live?.effort ?? finalAgent?.effort ?? plan?.effort ?? null;
      return {
        taskId: `${workflow.taskId}:agent:${label}`,
        description: label,
        subagentType: null,
        phase,
        statusKind,
        statusLabel,
        totalTokens: finalAgent?.tokens ?? live?.tokens ?? null,
        toolCalls: finalAgent?.toolCalls ?? live?.toolCalls ?? null,
        durationMs: finalAgent?.durationMs ?? liveDurationMs(live) ?? null,
        startedAt: live?.startedAt ?? entry.firstAt,
        threadId: null,
        model,
        modelLabel: formatSubagentModelLabel(model),
        effortLabel: effort,
        promptPreview: live?.promptPreview ?? finalAgent?.promptPreview ?? null,
        recentToolNames: live?.recentToolNames ?? [],
        lastToolName: finalAgent?.lastToolName ?? live?.recentToolNames.at(-1) ?? null,
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
        .map((agent): WorkflowAgentRow => {
          const { statusKind, statusLabel } = agentStatusPresentation(
            finalAgentStatus(agent.state, workflow.status),
          );
          const plan = planForLabel(agent.label);
          const model = agent.model ?? plan?.model ?? null;
          return {
            taskId: `${workflow.taskId}:agent:${agent.label}`,
            description: agent.label,
            subagentType: null,
            phase: finalAgentPhase(agent) ?? canonicalPhase(phaseForLabel(agent.label)),
            statusKind,
            statusLabel,
            totalTokens: agent.tokens,
            toolCalls: agent.toolCalls,
            durationMs: agent.durationMs,
            startedAt: workflow.startedAt,
            threadId: null,
            model,
            modelLabel: formatSubagentModelLabel(model),
            effortLabel: agent.effort ?? plan?.effort ?? null,
            promptPreview: agent.promptPreview,
            recentToolNames: [],
            lastToolName: agent.lastToolName,
          };
        })
    : [];

  // Live rows: transcript-poller snapshots for agents the progress stream never
  // named (or before their first progress event lands). Hidden once settled --
  // the final progress file is authoritative then.
  const liveOnlyRows = settled
    ? []
    : liveAgents
        .filter(
          (agent) =>
            !claimedLiveAgents.has(agent) &&
            (agent.label === null || !seenLabels.has(agent.label.toLowerCase())),
        )
        .map((agent, index): WorkflowAgentRow => {
          const label = agent.label ?? `Agent ${orderedLabels.length + index + 1}`;
          const plan = agent.label ? planForLabel(agent.label) : null;
          const { statusKind, statusLabel } = agentStatusPresentation(
            agent.state === "completed" ? "completed" : "running",
          );
          const model = agent.model ?? plan?.model ?? null;
          return {
            taskId: `${workflow.taskId}:agent-id:${agent.agentId}`,
            description: label,
            subagentType: null,
            phase: agent.label ? canonicalPhase(phaseForLabel(agent.label)) : null,
            statusKind,
            statusLabel,
            totalTokens: agent.tokens,
            toolCalls: agent.toolCalls,
            durationMs: liveDurationMs(agent),
            startedAt: agent.startedAt ?? workflow.startedAt,
            threadId: null,
            model,
            modelLabel: formatSubagentModelLabel(model),
            effortLabel: agent.effort ?? plan?.effort ?? null,
            promptPreview: agent.promptPreview,
            recentToolNames: agent.recentToolNames,
            lastToolName: agent.recentToolNames.at(-1) ?? null,
          };
        });

  const agents = [...memberRows, ...progressRows, ...backfilledRows, ...liveOnlyRows];

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
