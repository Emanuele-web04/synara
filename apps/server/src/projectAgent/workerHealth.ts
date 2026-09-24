import type { ProjectManagedWorkerSettleOutcome } from "@synara/contracts";

export const PROJECT_AGENT_WORKER_HEALTH_INTERVAL_MS = 60_000;

// Stuck detection thresholds (checked by inspectWorkerHealth on the health
// loop). A worker counts as stuck when it runs quiet for longer than
// QUIET_MS, or waits on an approval/user input for longer than WAITING_MS.
export const WORKER_STUCK_RUNNING_QUIET_MS = 10 * 60_000;
export const WORKER_STUCK_WAITING_MS = 5 * 60_000;

// A tool call still in flight counts as activity while it runs — the silence
// ladder must never interrupt it. Beyond this hard cap the ladder only nudges
// and notifies (never interrupts a running tool).
export const WORKER_TOOL_OVERTIME_MS = 45 * 60_000;

// A worker the coordinator created must show a session or a started turn
// within this grace window; afterwards it is treated as stuck (one counted
// re-dispatch attempt, then "Waiting on you").
export const WORKER_NEVER_STARTED_MS = 3 * 60_000;

// Programmatic stall-recovery ladder, run by the health loop (no model). Step 1
// nudges at the silent threshold; step 2 interrupts and re-dispatches the
// recorded task prompt after REDELIVER_DELAY_MS more quiet; the cap bounds
// automatic recoveries per thread before it is flagged "Waiting on you".
export const WORKER_RECOVERY_NUDGE_TEXT =
  "Automatic check from the coordinator: you have produced no output for 10 minutes. Post a one-line status, then continue or report a blocker.";
export const WORKER_RECOVERY_REDELIVER_DELAY_MS = 5 * 60_000;
export const WORKER_RECOVERY_MAX_ATTEMPTS = 2;
// Orchestration commands the ladder dispatches carry this prefix so the settle
// reactor can tell recovery-caused interrupts/steers from worker-owned events.
export const WORKER_RECOVERY_COMMAND_PREFIX = "agent-recovery:";

export function isFailedWorkerSessionStatus(status: string | null | undefined): boolean {
  return status === "error" || status === "interrupted" || status === "stopped";
}

// Once a worker records a terminal settle outcome its monitoring is done —
// later settle-class events (a replayed stop, a health-loop status pass) must
// not post a second row. Waiting outcomes are not terminal: the worker can
// still settle for real afterwards.
const TERMINAL_WORKER_SETTLE_OUTCOMES: ReadonlySet<ProjectManagedWorkerSettleOutcome> = new Set([
  "completed",
  "stopped",
  "failed",
  "interrupted",
  "missing",
]);

export function isTerminalWorkerSettleOutcome(
  outcome: ProjectManagedWorkerSettleOutcome | null,
): boolean {
  return outcome !== null && TERMINAL_WORKER_SETTLE_OUTCOMES.has(outcome);
}

// A worker is a thread the coordinator assigned to a task — ordinary group
// chat threads stay indexed for context but are never reported on or woken.
export function isManagedWorkerThread(input: {
  readonly threadId: string;
  readonly coordinatorThreadId: string;
  readonly assignedThreadIds: ReadonlySet<string>;
}): boolean {
  if (input.threadId === input.coordinatorThreadId) return false;
  return input.assignedThreadIds.has(input.threadId);
}

// Settle events that should wake the coordinator even from a non-worker group
// thread: a thread ending in error or needing the user is actionable; a normal
// user turn in a group chat is not.
const WORKER_ALERT_EVENT_TYPES = new Set([
  "worker.error",
  "worker.interrupted",
  "worker.missing",
  "worker.stopped",
  "worker.disconnected",
  "worker.silent",
  "worker.waiting-overdue",
  "worker.never-started",
  "worker.tool-overtime",
  "worker.needs-you",
  // Request-side waiting signals (the provider raised the request — the
  // response-requested event types fire when the USER answers instead).
  "approval.requested",
  "user-input.requested",
]);

export function isWorkerAlertEvent(eventType: string): boolean {
  return WORKER_ALERT_EVENT_TYPES.has(eventType);
}

// Ladder bookkeeping steps post their compact rows but never wake the
// coordinator model — only a give-up ("Waiting on you") or a real settle
// earns a coordinator turn.
export const WORKER_WAKE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "thread.turn-diff-completed",
  "thread.turn-interrupt-requested",
  "thread.session-stop-requested",
  "approval.requested",
  "user-input.requested",
  "worker.error",
  "worker.interrupted",
  "worker.stopped",
  "worker.missing",
  "worker.disconnected",
  "worker.needs-you",
]);

// A session whose projection says "running" but is absent from the live
// provider-session list is only flagged dead past this grace — fresh
// dispatches can lag the adapter listing by a few seconds.
export const WORKER_DISCONNECT_GRACE_MS = 90_000;

export function formatWorkerWatchLine(input: {
  readonly title: string;
  readonly status: string | null | undefined;
  readonly lastError: string | null | undefined;
}): string {
  const status = input.status ?? "unknown";
  if (input.lastError && input.lastError.trim().length > 0) {
    return `- ${input.title}: ${status} — ${input.lastError.trim()}`;
  }
  return `- ${input.title}: ${status}`;
}

export const WORKER_INBOX_REPORT_FILE = "report.md";
const WORKER_REPORT_ASSISTANT_TEXT_MAX_CHARS = 4_000;

const WORKER_SETTLEMENT_REPORT_EVENTS = new Set([
  "thread.turn-diff-completed",
  "thread.turn-interrupt-requested",
  "thread.session-stop-requested",
]);

export type WorkerSettlementOutcome = "completed" | "failed" | "interrupted" | "updated";

export function workerInboxReportPath(threadId: string): string {
  return `inbox/${threadId}/${WORKER_INBOX_REPORT_FILE}`;
}

export function shouldMaterializeWorkerSettlementReport(eventType: string): boolean {
  return WORKER_SETTLEMENT_REPORT_EVENTS.has(eventType) || eventType.startsWith("worker.");
}

export function classifyWorkerSettlement(input: {
  readonly eventType: string;
  readonly sessionStatus: string | null | undefined;
}): WorkerSettlementOutcome {
  const status = input.sessionStatus ?? "";
  const eventType = input.eventType;
  if (
    eventType.includes("interrupt") ||
    status === "interrupted" ||
    eventType === "worker.interrupted"
  ) {
    return "interrupted";
  }
  if (
    status === "error" ||
    eventType === "worker.error" ||
    eventType === "worker.missing" ||
    eventType === "worker.disconnected"
  ) {
    return "failed";
  }
  if (
    eventType === "thread.turn-diff-completed" ||
    eventType === "worker.stopped" ||
    eventType.includes("session-stop")
  ) {
    return "completed";
  }
  return "updated";
}

// One compact row posted into the coordinator thread per notable worker
// event. `settle` rows mark the worker settled (they count toward the batch
// roll-up); `stuck` rows report a stuck episode without settling it.
export interface WorkerMonitorNotice {
  readonly kind: "settle" | "stuck";
  readonly outcome: ProjectManagedWorkerSettleOutcome | null;
  readonly tone: "info" | "approval" | "error";
  readonly marker: "\u2713" | "\u26a0" | "\u2717";
  readonly phrase: string;
}

export function workerMonitorNoticeForEvent(eventType: string): WorkerMonitorNotice | null {
  switch (eventType) {
    case "thread.turn-diff-completed":
      return {
        kind: "settle",
        outcome: "completed",
        tone: "info",
        marker: "\u2713",
        phrase: "finished",
      };
    case "thread.session-stop-requested":
    case "worker.stopped":
      return {
        kind: "settle",
        outcome: "stopped",
        tone: "info",
        marker: "\u2713",
        phrase: "stopped",
      };
    case "approval.requested":
      return {
        kind: "settle",
        outcome: "waiting-approval",
        tone: "approval",
        marker: "\u26a0",
        phrase: "is waiting for your approval",
      };
    case "user-input.requested":
      return {
        kind: "settle",
        outcome: "waiting-input",
        tone: "approval",
        marker: "\u26a0",
        phrase: "needs your input",
      };
    case "thread.turn-interrupt-requested":
    case "worker.interrupted":
      return {
        kind: "settle",
        outcome: "interrupted",
        tone: "error",
        marker: "\u26a0",
        phrase: "was interrupted",
      };
    case "worker.error":
      return {
        kind: "settle",
        outcome: "failed",
        tone: "error",
        marker: "\u2717",
        phrase: "failed",
      };
    case "worker.missing":
      return {
        kind: "settle",
        outcome: "missing",
        tone: "error",
        marker: "\u2717",
        phrase: "went missing",
      };
    case "worker.disconnected":
      return {
        kind: "settle",
        outcome: "failed",
        tone: "error",
        marker: "\u2717",
        phrase: "lost its session",
      };
    case "worker.silent":
      return {
        kind: "stuck",
        outcome: null,
        tone: "approval",
        marker: "\u26a0",
        phrase: "has not reported for over 10 minutes",
      };
    case "worker.waiting-overdue":
      return {
        kind: "stuck",
        outcome: null,
        tone: "approval",
        marker: "\u26a0",
        phrase: "has been waiting for over 5 minutes",
      };
    case "worker.nudged":
      return {
        kind: "stuck",
        outcome: null,
        tone: "approval",
        marker: "\u26a0",
        phrase: "was nudged after 10 minutes without progress",
      };
    case "worker.recovery-redispatched":
      return {
        kind: "stuck",
        outcome: null,
        tone: "approval",
        marker: "\u26a0",
        phrase: "was interrupted and had its task re-dispatched",
      };
    case "worker.never-started":
      return {
        kind: "stuck",
        outcome: null,
        tone: "approval",
        marker: "\u26a0",
        phrase: "never started — no session or turn within 3 minutes",
      };
    case "worker.tool-overtime":
      return {
        kind: "stuck",
        outcome: null,
        tone: "approval",
        marker: "\u26a0",
        phrase: "has a tool call running for over 45 minutes",
      };
    case "worker.needs-you":
      return {
        kind: "stuck",
        outcome: null,
        tone: "error",
        marker: "\u2717",
        phrase: "needs you — automatic recovery is exhausted",
      };
    default:
      return null;
  }
}

export function formatWorkerMonitorRow(input: {
  readonly title: string;
  readonly marker: string;
  readonly phrase: string;
}): string {
  return `${input.marker} ${input.title} ${input.phrase}`;
}

const WORKER_ROLLUP_ENTRY_LABELS: Record<ProjectManagedWorkerSettleOutcome, string> = {
  completed: "\u2713",
  stopped: "\u2713",
  failed: "\u2717 failed",
  interrupted: "\u26a0 interrupted",
  missing: "\u2717 missing",
  "waiting-approval": "\u26a0 needs approval",
  "waiting-input": "\u26a0 needs input",
};

export function formatWorkerBatchRollup(input: {
  readonly threads: ReadonlyArray<{
    readonly title: string;
    readonly outcome: ProjectManagedWorkerSettleOutcome;
    /** Structured `synara_project_report_result` summary — preferred over the
     * generic outcome label when present. */
    readonly result?: string | null;
    /** Tracked PR URL for the worker thread, appended when known. */
    readonly pr?: string | null;
  }>;
}): string {
  const count = input.threads.length;
  const noun = count === 1 ? "thread" : "threads";
  const allFinished = input.threads.every(
    (thread) => thread.outcome === "completed" || thread.outcome === "stopped",
  );
  const entries = input.threads.map((thread) => {
    const result = thread.result?.split("\n")[0]?.trim();
    const pr = thread.pr?.trim() ? ` — ${thread.pr}` : "";
    if (result) {
      const clipped = result.length > 140 ? `${result.slice(0, 137)}...` : result;
      return `${thread.title}: ${clipped}${pr}`;
    }
    const missingResult = thread.outcome === "completed" ? " — no result filed" : "";
    return `${thread.title} ${WORKER_ROLLUP_ENTRY_LABELS[thread.outcome]}${missingResult}${pr}`;
  });
  if (allFinished) {
    return `All ${count} ${noun} finished: ${entries.join(", ")}`;
  }
  return `All ${count} ${noun} are done: ${entries.join(", ")}`;
}

export function lastAssistantTextFromMessages(
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = message.text.trim();
    if (text.length === 0) continue;
    return text.length > WORKER_REPORT_ASSISTANT_TEXT_MAX_CHARS
      ? `${text.slice(0, WORKER_REPORT_ASSISTANT_TEXT_MAX_CHARS)}\n\n[truncated]`
      : text;
  }
  return null;
}

export function formatWorkerSettlementReport(input: {
  readonly title: string;
  readonly threadId: string;
  readonly eventType: string;
  readonly status: string | null | undefined;
  readonly lastError: string | null | undefined;
  readonly lastAssistantText: string | null | undefined;
}): string {
  const outcome = classifyWorkerSettlement({
    eventType: input.eventType,
    sessionStatus: input.status,
  });
  const error = input.lastError?.trim() || "none";
  const lastReply = input.lastAssistantText?.trim() || "(none)";
  // No volatile fields (timestamps): identical thread state must produce the
  // identical report so the unchanged-skip in upsertSystemDocument matches.
  return [
    "# Worker report",
    "",
    `- Thread: ${input.title}`,
    `- Thread id: ${input.threadId}`,
    `- Event: ${input.eventType}`,
    `- Status: ${input.status ?? "unknown"}`,
    `- Outcome: ${outcome}`,
    "",
    "## Error",
    "",
    error,
    "",
    "## Last reply",
    "",
    lastReply,
    "",
  ].join("\n");
}
