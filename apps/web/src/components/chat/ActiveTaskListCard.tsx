import { pluralize } from "@synara/shared/text";
import {
  PiArrowsInSimple,
  PiArrowsOutSimple,
  PiSidebarSimple,
  PiSlidersHorizontal,
} from "react-icons/pi";

import type { ActiveTaskListState } from "../../session-logic";
import { TaskProgressSteps } from "./TaskProgressSteps";
import { BotIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { LiveStatusSpinner } from "../ui/spinner";
import {
  ComposerStackedPanelHeaderRow,
  ComposerStackedPanelRowLabel,
  ComposerStackedPanelRowMain,
} from "./ComposerStackedPanelContent";
import { COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME } from "./ComposerStackedPanel";
import {
  COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME,
  COMPOSER_STACKED_PANEL_FOOTER_ROW_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_CLASS_NAME,
  COMPOSER_STACKED_PANEL_SCROLL_REGION_CLASS_NAME,
} from "./composerStackedPanelStyles";

interface ActiveTaskListCardProps {
  activeTaskList: ActiveTaskListState;
  backgroundTaskCount?: number;
  compact?: boolean;
  onCompactChange: (compact: boolean) => void;
  onOpenSidebar: () => void;
}

export function ActiveTaskListCard({
  activeTaskList,
  backgroundTaskCount: backgroundTaskCountProp,
  compact: compactProp,
  onCompactChange,
  onOpenSidebar,
}: ActiveTaskListCardProps) {
  const backgroundTaskCount = backgroundTaskCountProp ?? 0;
  const compact = compactProp ?? false;
  const totalCount = activeTaskList.tasks.length;
  const completedCount = activeTaskList.tasks.filter((task) => task.status === "completed").length;
  const hasInProgressTask = activeTaskList.tasks.some((task) => task.status === "inProgress");
  const taskOccurrenceCount = new Map<string, number>();

  return (
    <>
      <ComposerStackedPanelHeaderRow>
        <ComposerStackedPanelRowMain>
          {compact && hasInProgressTask ? (
            <LiveStatusSpinner className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
          ) : (
            <PiSlidersHorizontal className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
          )}
          <ComposerStackedPanelRowLabel tone="meta">
            {completedCount} out of {totalCount} tasks completed
          </ComposerStackedPanelRowLabel>
        </ComposerStackedPanelRowMain>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
            onClick={onOpenSidebar}
            aria-label="Open tasks sidebar"
            title="Open tasks sidebar"
          >
            <PiSidebarSimple className="size-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
            onClick={() => onCompactChange(!compact)}
            aria-label={compact ? "Expand task banner" : "Collapse task banner"}
            title={compact ? "Expand task banner" : "Collapse task banner"}
          >
            {compact ? (
              <PiArrowsOutSimple className="size-3" />
            ) : (
              <PiArrowsInSimple className="size-3" />
            )}
          </Button>
        </div>
      </ComposerStackedPanelHeaderRow>

      {compact ? null : (
        <>
          <TaskProgressSteps
            textClassName="text-ui-lg"
            className={cn(
              COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME,
              COMPOSER_STACKED_PANEL_SCROLL_REGION_CLASS_NAME,
            )}
            steps={activeTaskList.tasks.map((task) => {
              const occurrence = (taskOccurrenceCount.get(task.task) ?? 0) + 1;
              taskOccurrenceCount.set(task.task, occurrence);
              return { id: `${task.task}:${occurrence}`, text: task.task, status: task.status };
            })}
          />

          {backgroundTaskCount > 0 ? (
            <div
              className={cn(
                COMPOSER_STACKED_PANEL_FOOTER_ROW_CLASS_NAME,
                COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME,
              )}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <BotIcon className="size-3 shrink-0" />
                <span className="truncate">
                  {backgroundTaskCount} background {pluralize(backgroundTaskCount, "agent")}
                </span>
              </div>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

export type { ActiveTaskListCardProps };
