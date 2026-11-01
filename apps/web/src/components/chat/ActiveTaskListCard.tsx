// FILE: ActiveTaskListCard.tsx
// Purpose: Renders the active plan/task activity panel opened from the composer's task
// capsule (see ComposerActiveTaskListCard).
// Layer: Chat composer UI
// Exports: ActiveTaskListCard

import { pluralize } from "@synara/shared/text";
import { PiSidebarSimple, PiSlidersHorizontal } from "react-icons/pi";

import type { ActiveTaskListState } from "../../session-logic";
import { TaskProgressSteps } from "./TaskProgressSteps";
import { BotIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
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
import { useTranslation } from "~/i18n";

interface ActiveTaskListCardProps {
  activeTaskList: ActiveTaskListState;
  backgroundTaskCount?: number;
  onOpenSidebar: () => void;
}

export function ActiveTaskListCard({
  activeTaskList,
  backgroundTaskCount: backgroundTaskCountProp,
  onOpenSidebar,
}: ActiveTaskListCardProps) {
  const { t } = useTranslation();

  const backgroundTaskCount = backgroundTaskCountProp ?? 0;
  const totalCount = activeTaskList.tasks.length;
  const completedCount = activeTaskList.tasks.filter((task) => task.status === "completed").length;
  const taskOccurrenceCount = new Map<string, number>();

  return (
    <>
      <ComposerStackedPanelHeaderRow>
        <ComposerStackedPanelRowMain>
          <PiSlidersHorizontal className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
          <ComposerStackedPanelRowLabel tone="meta">
            {completedCount} {t("chat:outOf")} {totalCount} {t("chat:tasksCompleted")}
          </ComposerStackedPanelRowLabel>
        </ComposerStackedPanelRowMain>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
            onClick={onOpenSidebar}
            aria-label={t("chat:activeTaskList_openTasksSidebar")}
            title={t("chat:activeTaskList_openTasksSidebar")}
          >
            <PiSidebarSimple className="size-3" />
          </Button>
        </div>
      </ComposerStackedPanelHeaderRow>

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
              {backgroundTaskCount} {t("chat:background")} {pluralize(backgroundTaskCount, "agent")}
            </span>
          </div>
        </div>
      ) : null}
    </>
  );
}

export type { ActiveTaskListCardProps };
