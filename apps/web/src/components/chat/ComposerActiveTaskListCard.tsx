// FILE: ComposerActiveTaskListCard.tsx
// Purpose: Active task-list card stacked flush above the composer. Wraps
// ActiveTaskListCard in the shared stacked-header frame. The card participates in
// normal composer flow and does not need to expose a measurement ref.
// Layer: Chat composer UI
// Exports: ComposerActiveTaskListCard

import { memo } from "react";

import type { ActiveTaskListState } from "../../session-logic";
import { ActiveTaskListCard } from "./ActiveTaskListCard";
import { ComposerStackedPanel } from "./ComposerStackedPanel";

interface ComposerActiveTaskListCardProps {
  activeTaskList: ActiveTaskListState;
  backgroundTaskCount: number;
  compact: boolean;
  onCompactChange: (compact: boolean) => void;
  onOpenSidebar: () => void;
  attachedToPrevious?: boolean;
}

export const ComposerActiveTaskListCard = memo(function ComposerActiveTaskListCard({
  activeTaskList,
  backgroundTaskCount,
  compact,
  onCompactChange,
  onOpenSidebar,
  attachedToPrevious = false,
}: ComposerActiveTaskListCardProps) {
  return (
    <ComposerStackedPanel
      passthroughSideMargins
      attachedToPrevious={attachedToPrevious}
      data-testid="active-task-list-card"
    >
      <ActiveTaskListCard
        activeTaskList={activeTaskList}
        backgroundTaskCount={backgroundTaskCount}
        compact={compact}
        onCompactChange={onCompactChange}
        onOpenSidebar={onOpenSidebar}
      />
    </ComposerStackedPanel>
  );
});
