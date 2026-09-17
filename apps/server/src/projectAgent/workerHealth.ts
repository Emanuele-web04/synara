export const PROJECT_AGENT_WORKER_HEALTH_INTERVAL_MS = 60_000;

export function isFailedWorkerSessionStatus(status: string | null | undefined): boolean {
  return status === "error" || status === "interrupted" || status === "stopped";
}

export function isManagedWorkerThread(input: {
  readonly threadId: string;
  readonly coordinatorThreadId: string;
  readonly index: ReadonlyArray<{
    readonly threadId: string;
    readonly excluded: boolean;
    readonly archived: boolean;
  }>;
}): boolean {
  if (input.threadId === input.coordinatorThreadId) return false;
  return input.index.some(
    (entry) => entry.threadId === input.threadId && !entry.excluded && !entry.archived,
  );
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
