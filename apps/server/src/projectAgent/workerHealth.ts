export const PROJECT_AGENT_WORKER_HEALTH_INTERVAL_MS = 60_000;

export function isFailedWorkerSessionStatus(status: string | null | undefined): boolean {
  return status === "error" || status === "interrupted" || status === "stopped";
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
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
]);

export function isWorkerAlertEvent(eventType: string): boolean {
  return WORKER_ALERT_EVENT_TYPES.has(eventType);
}

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
  if (status === "error" || eventType === "worker.error" || eventType === "worker.missing") {
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
