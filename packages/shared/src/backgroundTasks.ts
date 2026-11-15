/**
 * Thread-wide outstanding background tasks, folded from a thread's activity log.
 *
 * Shared by the server (authoritative `pendingBackgroundTaskCount` on thread
 * shells) and the web client so both apply exactly the same rules.
 */

/** Minimal activity shape the fold reads; full thread activities satisfy it. */
export interface BackgroundTaskActivity {
  readonly kind: string;
  readonly payload: unknown;
}

/** Provider notice ("Moved to background") that lists newly backgrounded tasks. */
export const BACKGROUND_TASKS_CHANGED_NATIVE_EVENT_TYPE = "background_tasks_changed";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * True for activities that can change the outstanding background-task set:
 * a task status patch, a task's end, or a "Moved to background" notice.
 * Task progress and other runtime warnings never change it.
 */
export function isBackgroundTaskActivity(activity: BackgroundTaskActivity): boolean {
  if (activity.kind === "task.updated" || activity.kind === "task.completed") {
    return true;
  }
  return (
    activity.kind === "runtime.warning" &&
    asRecord(activity.payload)?.nativeEventType === BACKGROUND_TASKS_CHANGED_NATIVE_EVENT_TYPE
  );
}

/**
 * Background tasks still running anywhere in the thread, folded over
 * `activities` in the order given (callers sort by sequence first).
 *
 * Not scoped to the latest turn: once a finished subagent wakes the agent into
 * a new turn, the subagents launched by the earlier turn are still outstanding.
 * Claude announces backgrounded work with a "Moved to background" notice, so
 * both that notice and an `isBackgrounded` patch count.
 */
export function foldOutstandingBackgroundTaskIds(
  activities: Iterable<BackgroundTaskActivity>,
): string[] {
  const outstanding = new Set<string>();
  for (const activity of activities) {
    const payload = asRecord(activity.payload);
    if (activity.kind === "runtime.warning") {
      if (payload?.nativeEventType !== BACKGROUND_TASKS_CHANGED_NATIVE_EVENT_TYPE) continue;
      const data = asRecord(payload.data);
      if (!Array.isArray(data?.tasks)) continue;
      for (const task of data.tasks) {
        const taskId = asRecord(task)?.task_id;
        if (typeof taskId === "string") outstanding.add(taskId);
      }
      continue;
    }
    const taskId = typeof payload?.taskId === "string" ? payload.taskId : null;
    if (!taskId) continue;
    if (activity.kind === "task.completed") {
      outstanding.delete(taskId);
    } else if (activity.kind === "task.updated") {
      const status = typeof payload?.status === "string" ? payload.status : undefined;
      if (
        status === "completed" ||
        status === "failed" ||
        status === "killed" ||
        status === "paused" ||
        payload?.isBackgrounded === false
      ) {
        outstanding.delete(taskId);
      } else if (payload?.isBackgrounded === true) {
        outstanding.add(taskId);
      }
    }
  }
  return [...outstanding];
}

/**
 * Session statuses that can still finish background work. A stopped or failed
 * session cannot, so its tasks stop counting. A thread without a session has
 * no live work either.
 */
export function canSessionFinishBackgroundTasks(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && status !== "stopped" && status !== "error";
}
