// FILE: ComposerActiveTaskListCard.tsx
// Purpose: Active task-list card stacked flush above the composer. Wraps
// ActiveTaskListCard in the shared stacked-header frame and exposes the measured
// element ref so the transcript can inset its bottom padding by the card height.
// Layer: Chat composer UI
// Exports: ComposerActiveTaskListCard

import { memo, type RefObject } from "react";

import type { ActiveTaskListState } from "../../session-logic";
import { ActiveTaskListCard } from "./ActiveTaskListCard";
import { ComposerStackedHeaderFrame } from "./ComposerColumnFrame";

interface ComposerActiveTaskListCardProps {
  activeTaskList: ActiveTaskListState;
  // Measured element used to inset the transcript's bottom padding by the card height.
  cardRef: RefObject<HTMLDivElement | null>;
  backgroundTaskCount: number;
  compact: boolean;
  onCompactChange: (compact: boolean) => void;
  onOpenSidebar: () => void;
}

export const ComposerActiveTaskListCard = memo(function ComposerActiveTaskListCard({
  activeTaskList,
  cardRef,
  backgroundTaskCount,
  compact,
  onCompactChange,
  onOpenSidebar,
}: ComposerActiveTaskListCardProps) {
  return (
    <ComposerStackedHeaderFrame ref={cardRef} passthroughSideMargins>
      <ActiveTaskListCard
        activeTaskList={activeTaskList}
        backgroundTaskCount={backgroundTaskCount}
        compact={compact}
        onCompactChange={onCompactChange}
        onOpenSidebar={onOpenSidebar}
      />
    </ComposerStackedHeaderFrame>
  );
});
