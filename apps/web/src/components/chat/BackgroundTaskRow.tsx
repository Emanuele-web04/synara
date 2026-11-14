// FILE: BackgroundTaskRow.tsx
// Purpose: The transcript row a background task keeps once its tool run is
//          expanded: "`sleep 20 && echo done` · running", then "finished 20s" /
//          "failed · exit 1" / "stopped" in place. Static on purpose: the live
//          clock and Stop live in the Environment panel and the right-dock
//          Background tasks list, so the transcript never ticks.
// Layer: Web chat presentation component
// Exports: BackgroundTaskRow

import { BackgroundTrayIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import type { WorkLogBackgroundTask } from "../../workLog";
import { deriveLiteralCommand } from "../../lib/toolCallLabel";
import { describeBackgroundTaskStatus } from "./backgroundTaskRow.logic";
import { useTranslation } from "~/i18n";

export function BackgroundTaskRow(props: { task: WorkLogBackgroundTask; fontSizePx: number }) {
  const { t } = useTranslation();

  const { task, fontSizePx } = props;
  // A running task shows no clock here; settled ones keep how long they ran.
  const status = describeBackgroundTaskStatus(task, task.completedAt ?? task.startedAt, t);
  const command = task.command ? deriveLiteralCommand(task.command) : null;
  const subject = command ?? task.description ?? t("chat:backgroundTask");

  return (
    <div
      className="flex min-w-0 items-center gap-1.5 py-0.5"
      style={{ fontSize: `${fontSizePx}px` }}
      data-background-task={task.taskId}
      data-background-task-status={task.status}
      title={task.description && command ? task.description : t("chat:backgroundTask")}
    >
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center",
          MUTED_LABEL_TEXT_CLASS_NAME,
        )}
        aria-hidden
      >
        <BackgroundTrayIcon className="size-3.5" />
      </span>
      <span className={cn("min-w-0 truncate leading-5", MUTED_LABEL_TEXT_CLASS_NAME)}>
        {subject}
      </span>
      <span
        className={cn(
          "ml-auto flex shrink-0 items-center gap-1.5 pl-2 tabular-nums",
          MUTED_LABEL_TEXT_CLASS_NAME,
        )}
      >
        <span
          className={cn(task.status === "failed" && "text-destructive")}
          data-background-task-label="true"
        >
          {status.label}
        </span>
        {task.status !== "running" && status.elapsed ? <span>{status.elapsed}</span> : null}
      </span>
    </div>
  );
}
