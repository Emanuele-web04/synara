// FILE: backgroundTaskRow.logic.ts
// Purpose: Wording for the single transcript row a background task keeps for its
//          whole life ("running 12s" → "finished · 20s") and for the line that
//          groups three or more of them.
// Layer: Web chat presentation helpers
// Exports: describeBackgroundTaskStatus, summarizeBackgroundTaskGroup

import { pluralize } from "~/i18n/pluralize";
import { t } from "~/i18n";

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
      return { status: task.status, label: translate("running"), elapsed };
    case "finished":
      return { status: task.status, label: translate("finished"), elapsed };
    case "failed":
      return {
        status: task.status,
        label:
          task.exitCode !== null
            ? translate("failed · exit {{value0}}", { value0: task.exitCode })
            : translate("failed"),
        elapsed,
      };
    case "stopped":
      return { status: task.status, label: translate("stopped"), elapsed };
  }
}

const STATUS_ORDER: ReadonlyArray<WorkLogBackgroundTask["status"]> = [
  "running",
  "finished",
  "failed",
  "stopped",
];

// "4 background tasks · 3 finished, 1 stopped".
export function summarizeBackgroundTaskGroup(
  tasks: ReadonlyArray<Pick<WorkLogBackgroundTask, "status">>,
  translate: typeof t = t,
): string {
  const counts = STATUS_ORDER.map(
    (status) => [status, tasks.filter((task) => task.status === status).length] as const,
  ).filter(([, count]) => count > 0);
  const breakdown = counts
    .map(([status, count]) => translate(`{{value0}} ${status}`, { value0: count, count }))
    .join(", ");
  const head = translate("{{value0}} background {{value1}}", {
    value0: tasks.length,
    value1: pluralize(tasks.length, "task"),
  });
  return breakdown ? `${head} · ${breakdown}` : head;
}
