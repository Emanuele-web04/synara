// FILE: backgroundTaskRow.logic.ts
// Purpose: Status wording for a background task ("running" → "finished · 20s",
//          "failed · exit 1"), shared by its transcript row and the right-dock list.
// Layer: Web chat presentation helpers
// Exports: describeBackgroundTaskStatus, countBackgroundTasks, backgroundTaskTitle

import { t } from "~/i18n";

import { deriveFriendlyCommandTarget } from "../../lib/toolCallLabel";
import { formatClockElapsed } from "../../session-logic";
import type { WorkLogBackgroundTask } from "../../workLog";

export interface BackgroundTaskStatusDisplay {
  status: WorkLogBackgroundTask["status"];
  // "running", "finished", "failed · exit 1", "stopped".
  label: string;
  // Time the task has run (live) or ran; null when unknown.
  elapsed: string | null;
}

export function describeBackgroundTaskStatus(
  task: Pick<WorkLogBackgroundTask, "status" | "startedAt" | "completedAt" | "exitCode">,
  nowIso: string,
  translate: typeof t = t,
): BackgroundTaskStatusDisplay {
  const elapsed = formatClockElapsed(task.startedAt, task.completedAt ?? nowIso);
  switch (task.status) {
    case "running":
      return { status: task.status, label: translate("chat:running"), elapsed };
    case "finished":
      return { status: task.status, label: translate("chat:finished"), elapsed };
    case "failed":
      return {
        status: task.status,
        label:
          task.exitCode !== null
            ? translate("chat:failedExit", { value0: task.exitCode })
            : translate("common:failed"),
        elapsed,
      };
    case "stopped":
      return { status: task.status, label: translate("chat:stopped2"), elapsed };
  }
}

export interface BackgroundTaskCounts {
  running: number;
  // Every task that ended, however it ended.
  settled: number;
  failed: number;
}

export function countBackgroundTasks(
  tasks: ReadonlyArray<Pick<WorkLogBackgroundTask, "status">>,
): BackgroundTaskCounts {
  let running = 0;
  let failed = 0;
  for (const task of tasks) {
    if (task.status === "running") running += 1;
    else if (task.status === "failed") failed += 1;
  }
  return { running, settled: tasks.length - running, failed };
}

// The short name a list row leads with: what ran, without env assignments or
// shell wrappers ("bun run dev:server"), falling back to the provider's description.
export function backgroundTaskTitle(
  task: Pick<WorkLogBackgroundTask, "command" | "description">,
  translate: typeof t = t,
): string {
  return task.command
    ? deriveFriendlyCommandTarget(task.command)
    : (task.description ?? translate("chat:backgroundTask"));
}
