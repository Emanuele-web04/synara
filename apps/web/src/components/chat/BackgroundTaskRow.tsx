// FILE: BackgroundTaskRow.tsx
// Purpose: The one transcript row a background task keeps for its whole life:
//          "`sleep 20 && echo done` · 12s [Stop]" behind a spinner, then
//          "finished 20s" / "failed · exit 1" / "stopped" in place. Borderless
//          and one color (the live spinner), like the transcript's tool rows.
// Layer: Web chat presentation component
// Exports: BackgroundTaskRow, BackgroundTaskStopContext

import { createContext, useContext } from "react";

import { BackgroundTrayIcon, StopIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import type { WorkLogBackgroundTask } from "../../workLog";
import { deriveLiteralCommand } from "../../lib/toolCallLabel";
import { Button } from "../ui/button";
import { LiveStatusSpinner } from "../ui/spinner";
import { describeBackgroundTaskStatus } from "./backgroundTaskRow.logic";
import { INLINE_COMMAND_CHIP_CLASS_NAME } from "./chatTypography";
import { LiveElapsedTimer } from "./LiveElapsedTimer";

// Stops a running background task; absent where the transcript cannot act on
// the thread (read-only surfaces).
export const BackgroundTaskStopContext = createContext<((taskId: string) => void) | null>(null);

export function BackgroundTaskRow(props: { task: WorkLogBackgroundTask; fontSizePx: number }) {
  const { task, fontSizePx } = props;
  const onStop = useContext(BackgroundTaskStopContext);
  // A running task's clock ticks in LiveElapsedTimer; settled ones use their end.
  const status = describeBackgroundTaskStatus(task, task.completedAt ?? task.startedAt);
  const running = task.status === "running";
  const command = task.command ? deriveLiteralCommand(task.command) : null;
  const subject = command ?? task.description ?? "Background task";

  return (
    <div
      className="flex min-w-0 items-center gap-1.5 py-0.5"
      style={{ fontSize: `${fontSizePx}px` }}
      data-background-task={task.taskId}
      data-background-task-status={task.status}
      title={task.description && command ? task.description : "Background task"}
    >
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center",
          MUTED_LABEL_TEXT_CLASS_NAME,
        )}
        aria-hidden
      >
        {running ? (
          <LiveStatusSpinner className="size-3.5 text-sky-600 dark:text-sky-300" />
        ) : (
          <BackgroundTrayIcon className="size-3.5" />
        )}
      </span>
      <span className="min-w-0 truncate leading-5">
        {command ? (
          <code className={INLINE_COMMAND_CHIP_CLASS_NAME}>{subject}</code>
        ) : (
          <span className={MUTED_LABEL_TEXT_CLASS_NAME}>{subject}</span>
        )}
      </span>
      <span
        className={cn(
          "ml-auto flex shrink-0 items-center gap-1.5 pl-2 tabular-nums",
          MUTED_LABEL_TEXT_CLASS_NAME,
        )}
      >
        <span
          className={cn(running && "sr-only", task.status === "failed" && "text-destructive")}
          data-background-task-label="true"
        >
          {status.label}
        </span>
        {running ? (
          <LiveElapsedTimer startedAt={task.startedAt} />
        ) : status.elapsed ? (
          <span>{status.elapsed}</span>
        ) : null}
        {running && onStop ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0 text-foreground/80"
            onClick={() => onStop(task.taskId)}
            aria-label={`Stop background task ${subject}`}
          >
            <StopIcon className="size-2.5" />
            Stop
          </Button>
        ) : null}
      </span>
    </div>
  );
}
