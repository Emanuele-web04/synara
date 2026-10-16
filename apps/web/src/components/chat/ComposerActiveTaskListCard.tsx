// FILE: ComposerActiveTaskListCard.tsx
// Purpose: Active task-list capsule above the composer ("1/3 tasks", spinning while a
// task runs). Clicking it opens the full ActiveTaskListCard in a popover.
// Layer: Chat composer UI
// Exports: ComposerActiveTaskListCard

import { PiSlidersHorizontal } from "react-icons/pi";

import type { ActiveTaskListState } from "../../session-logic";
import { LiveStatusSpinner } from "../ui/spinner";
import { ActiveTaskListCard } from "./ActiveTaskListCard";
import { ComposerCapsulePopover } from "./ComposerCapsule";
import { COMPOSER_STACKED_PANEL_ICON_CLASS_NAME } from "./composerStackedPanelStyles";

interface ComposerActiveTaskListCardProps {
  activeTaskList: ActiveTaskListState;
  backgroundTaskCount: number;
  onOpenSidebar: () => void;
}

export function ComposerActiveTaskListCard({
  activeTaskList,
  backgroundTaskCount,
  onOpenSidebar,
}: ComposerActiveTaskListCardProps) {
  const totalCount = activeTaskList.tasks.length;
  const completedCount = activeTaskList.tasks.filter((task) => task.status === "completed").length;
  const hasInProgressTask = activeTaskList.tasks.some((task) => task.status === "inProgress");
  return (
    <ComposerCapsulePopover
      icon={
        hasInProgressTask ? (
          <LiveStatusSpinner className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
        ) : (
          <PiSlidersHorizontal className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
        )
      }
      label={
        <span className="tabular-nums">
          {completedCount}/{totalCount} tasks
        </span>
      }
      title={`${completedCount} out of ${totalCount} tasks completed`}
      testId="active-task-list-capsule"
      popupTestId="active-task-list-card"
    >
      {(close) => (
        <ActiveTaskListCard
          activeTaskList={activeTaskList}
          backgroundTaskCount={backgroundTaskCount}
          onOpenSidebar={() => {
            close();
            onOpenSidebar();
          }}
        />
      )}
    </ComposerCapsulePopover>
  );
}
