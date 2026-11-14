// FILE: BackgroundTaskRow.tsx
// Purpose: The transcript row a background task keeps once its tool run is
//          expanded: "`sleep 20 && echo done` · running", then "finished 20s" /
//          "failed · exit 1" / "stopped" in place. The transcript never ticks.
//          Stop is available here only when the chat has no Environment panel.
// Layer: Web chat presentation component
// Exports: BackgroundTaskRow, BackgroundTaskStopContext

import { createContext, useContext } from "react";

import { BackgroundTrayIcon, StopIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import type { WorkLogBackgroundTask } from "../../workLog";
import { deriveLiteralCommand } from "../../lib/toolCallLabel";
import { Button } from "../ui/button";
import { describeBackgroundTaskStatus } from "./backgroundTaskRow.logic";
import { useTranslation } from "~/i18n";

// ChatView supplies Stop only for the transcript that owns the task.
export const BackgroundTaskStopContext = createContext<((taskId: string) => void) | null>(null);

export function BackgroundTaskRow(props: { task: WorkLogBackgroundTask; fontSizePx: number }) {
  const { t } = useTranslation();

  const { task, fontSizePx } = props;
  const onStop = useContext(BackgroundTaskStopContext);
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
        {task.status === "running" && onStop ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0 text-foreground/80"
            onClick={() => onStop(task.taskId)}
            aria-label={t("chat:stopBackgroundTask", { value0: subject })}
          >
            <StopIcon className="size-2.5" />
            {t("chat:stop")}
          </Button>
        ) : null}
      </span>
    </div>
  );
}
