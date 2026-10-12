// FILE: backgroundTaskRow.logic.ts
// Purpose: Wording for the single transcript row a background task keeps for its
//          whole life ("running 12s" → "finished · 20s") and for the line that
//          groups three or more of them.
// Layer: Web chat presentation helpers
// Exports: describeBackgroundTaskStatus, summarizeBackgroundTaskGroup

import { pluralize } from "@synara/shared/text";

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
): BackgroundTaskStatusDisplay {
  const elapsed = formatClockElapsed(task.startedAt, task.completedAt ?? nowIso);
  switch (task.status) {
    case "running":
      return { status: task.status, label: "running", elapsed };
    case "finished":
      return { status: task.status, label: "finished", elapsed };
    case "failed":
      return {
        status: task.status,
        label: task.exitCode !== null ? `failed · exit ${task.exitCode}` : "failed",
        elapsed,
      };
    case "stopped":
      return { status: task.status, label: "stopped", elapsed };
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
): string {
  const counts = STATUS_ORDER.map(
    (status) => [status, tasks.filter((task) => task.status === status).length] as const,
  ).filter(([, count]) => count > 0);
  const breakdown = counts.map(([status, count]) => `${count} ${status}`).join(", ");
  const head = `${tasks.length} background ${pluralize(tasks.length, "task")}`;
  return breakdown ? `${head} · ${breakdown}` : head;
}
