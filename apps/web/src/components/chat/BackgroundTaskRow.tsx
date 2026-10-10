// FILE: BackgroundTaskRow.tsx
// Purpose: The one transcript row a background task keeps for its whole life:
//          "Background · `sleep 20 && echo done` · running 12s [Stop]", then
//          "finished 20s" / "failed · exit 1" / "stopped" in place.
// Layer: Web chat presentation component
// Exports: BackgroundTaskRow, BackgroundTaskStopContext

import { createContext, useContext } from "react";

import { BackgroundTrayIcon, StopIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import type { WorkLogBackgroundTask } from "../../workLog";
import { deriveLiteralCommand } from "../../lib/toolCallLabel";
import { LiveStatusSpinner } from "../ui/spinner";
import { describeBackgroundTaskStatus } from "./backgroundTaskRow.logic";
import { INLINE_COMMAND_CHIP_CLASS_NAME } from "./chatTypography";
import { LiveElapsedTimer } from "./LiveElapsedTimer";

// Stops a running background task; absent where the transcript cannot act on
// the thread (read-only surfaces).
export const BackgroundTaskStopContext = createContext<((taskId: string) => void) | null>(null);

const STATUS_TONE_CLASS_NAME: Record<WorkLogBackgroundTask["status"], string> = {
  running: "text-sky-600 dark:text-sky-300",
  finished: "text-emerald-600 dark:text-emerald-300/90",
  failed: "text-destructive",
  stopped: MUTED_LABEL_TEXT_CLASS_NAME,
};

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
      className="my-0.5 flex min-w-0 items-center gap-1.5 rounded-lg border border-border/60 px-2 py-1"
      style={{ fontSize: `${fontSizePx}px` }}
      data-background-task={task.taskId}
      data-background-task-status={task.status}
      title={task.description && command ? task.description : undefined}
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
      <span className={cn("shrink-0", MUTED_LABEL_TEXT_CLASS_NAME)}>Background</span>
      <span className={cn("shrink-0", MUTED_LABEL_TEXT_CLASS_NAME)} aria-hidden>
        ·
      </span>
      <span className="min-w-0 truncate leading-5">
        {command ? (
          <code className={INLINE_COMMAND_CHIP_CLASS_NAME}>{subject}</code>
        ) : (
          <span className={MUTED_LABEL_TEXT_CLASS_NAME}>{subject}</span>
        )}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 tabular-nums">
        <span className={STATUS_TONE_CLASS_NAME[task.status]} data-background-task-label="true">
          {status.label}
        </span>
        {running ? (
          <span className={MUTED_LABEL_TEXT_CLASS_NAME}>
            <LiveElapsedTimer startedAt={task.startedAt} />
          </span>
        ) : status.elapsed ? (
          <span className={MUTED_LABEL_TEXT_CLASS_NAME}>{status.elapsed}</span>
        ) : null}
        {running && onStop ? (
          <button
            type="button"
            className="ml-1 inline-flex items-center gap-1 rounded-md border border-border/70 px-1.5 py-px text-foreground/80 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground"
            onClick={() => onStop(task.taskId)}
            aria-label={`Stop background task ${subject}`}
          >
            <StopIcon className="size-2.5" />
            Stop
          </button>
        ) : null}
      </span>
    </div>
  );
}
