// FILE: BackgroundTasksDockPane.tsx
// Purpose: Right-dock list of the thread's background tasks (opened from the
//          Environment panel summary). Running rows lead with the command and when it
//          started, with Stop on hover; finished rows show how each one ended. Two lines
//          per task, truncated, with a static terminal glyph: no spinners, and the time
//          labels refresh once a minute.
// Layer: Chat right-dock UI
// Exports: BackgroundTasksDockPane

import type { ThreadId } from "@synara/contracts";

import { IconButton } from "~/components/ui/icon-button";
import { useNowMs } from "~/hooks/useNowMs";
import { useTranslation } from "~/i18n";
import { StopIcon, TerminalIcon } from "~/lib/icons";
import { formatRelativeTimeAgo } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";

import { deriveLiteralCommand } from "../../lib/toolCallLabel";
import type { WorkLogBackgroundTask } from "../../workLog";
import { backgroundTaskTitle, describeBackgroundTaskStatus } from "./backgroundTaskRow.logic";
import {
  DOCK_LIST_CLASS_NAME,
  DOCK_LIST_SECONDARY_TEXT_CLASS_NAME,
  DockListCappedSection,
  DockListHeading,
} from "./DockList";
import { ENVIRONMENT_ROW_CLASS_NAME, EnvironmentRowBody } from "./environment/EnvironmentRow";
import { PanelStateMessage } from "./PanelStateMessage";
import { useStopBackgroundTask, useThreadBackgroundTasks } from "./useThreadBackgroundTasks";

// Finished rows shown before "Show more"; running rows always render.
const FINISHED_VISIBLE_LIMIT = 10;
const TIME_REFRESH_INTERVAL_MS = 60_000;

function BackgroundTaskListRow({
  task,
  nowMs,
  onStop,
}: {
  task: WorkLogBackgroundTask;
  nowMs: number;
  onStop: ((taskId: string) => void) | null;
}) {
  const { t, formatLocale } = useTranslation();

  const running = task.status === "running";
  const title = backgroundTaskTitle(task, t);
  const literalCommand = task.command ? deriveLiteralCommand(task.command) : null;
  const status = describeBackgroundTaskStatus(task, task.completedAt ?? task.startedAt, t);
  const timeLabel = formatRelativeTimeAgo(
    task.completedAt ?? task.startedAt,
    nowMs,
    formatLocale,
    t,
  );
  const showStop = running && onStop !== null;

  // Stop overlays the first line instead of nesting in the row; on hover the time
  // gives way to a spacer that reserves its slot. Hidden, it takes no clicks.
  return (
    <div className="group/background-task relative" data-background-task-row={task.status}>
      <div
        className={cn(ENVIRONMENT_ROW_CLASS_NAME, "cursor-default items-start")}
        title={[task.command, task.description].filter(Boolean).join("\n\n") || undefined}
      >
        <EnvironmentRowBody
          icon={
            <TerminalIcon
              aria-hidden
              className={cn(
                "mt-0.5 size-4 shrink-0",
                !running && DOCK_LIST_SECONDARY_TEXT_CLASS_NAME,
              )}
            />
          }
          label={
            <span className="flex min-w-0 flex-col">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate">{title}</span>
                <span
                  className={cn(
                    "shrink-0 text-ui-sm",
                    DOCK_LIST_SECONDARY_TEXT_CLASS_NAME,
                    showStop &&
                      "group-focus-within/background-task:hidden group-hover/background-task:hidden",
                  )}
                >
                  {timeLabel}
                </span>
                {showStop ? (
                  <span
                    aria-hidden
                    className="hidden w-6 shrink-0 group-focus-within/background-task:block group-hover/background-task:block"
                  />
                ) : null}
              </span>
              <span className={cn("truncate text-ui-sm", DOCK_LIST_SECONDARY_TEXT_CLASS_NAME)}>
                <span className={cn(task.status === "failed" && "text-destructive")}>
                  {status.label}
                </span>
                {!running && status.elapsed ? ` · ${status.elapsed}` : null}
                {literalCommand && literalCommand !== title ? ` · ${literalCommand}` : null}
              </span>
            </span>
          }
        />
      </div>
      {showStop ? (
        <div className="pointer-events-none absolute top-0.5 right-2 flex items-center opacity-0 transition-opacity group-focus-within/background-task:pointer-events-auto group-focus-within/background-task:opacity-100 group-hover/background-task:pointer-events-auto group-hover/background-task:opacity-100">
          <IconButton
            label={t("chat:stopBackgroundTask", { value0: title })}
            tooltip={t("chat:stop")}
            onClick={() => onStop(task.taskId)}
          >
            <StopIcon className="size-3.5" />
          </IconButton>
        </div>
      ) : null}
    </div>
  );
}

function BackgroundTasksList({
  tasks,
  nowMs,
  onStop,
}: {
  tasks: ReadonlyArray<WorkLogBackgroundTask>;
  nowMs: number;
  onStop: ((taskId: string) => void) | null;
}) {
  const { t } = useTranslation();

  // Newest first in both sections.
  const running = tasks.filter((task) => task.status === "running").toReversed();
  const finished = tasks.filter((task) => task.status !== "running").toReversed();

  return (
    <div className={DOCK_LIST_CLASS_NAME} data-testid="background-tasks-dock-pane">
      {tasks.length === 0 ? (
        <PanelStateMessage>{t("chat:noBackgroundTasksInThisChatYet")}</PanelStateMessage>
      ) : null}
      {running.length > 0 ? (
        <>
          <DockListHeading label={t("automation:detail_active")} count={running.length} />
          {running.map((task) => (
            <BackgroundTaskListRow key={task.taskId} task={task} nowMs={nowMs} onStop={onStop} />
          ))}
        </>
      ) : null}
      <DockListCappedSection
        label={t("git:detail_done")}
        items={finished}
        limit={FINISHED_VISIBLE_LIMIT}
        renderItem={(task) => (
          <BackgroundTaskListRow key={task.taskId} task={task} nowMs={nowMs} onStop={null} />
        )}
      />
    </div>
  );
}

export function BackgroundTasksDockPane({ hostThreadId }: { hostThreadId: ThreadId }) {
  const tasks = useThreadBackgroundTasks(hostThreadId);
  const stopBackgroundTask = useStopBackgroundTask(hostThreadId);
  const nowMs = useNowMs(tasks.length > 0, TIME_REFRESH_INTERVAL_MS);

  return <BackgroundTasksList tasks={tasks} nowMs={nowMs} onStop={stopBackgroundTask} />;
}
