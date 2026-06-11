// FILE: ComposerLiveChangesHeader.tsx
// Purpose: Live "N files changed +X -Y" strip stacked flush onto the top of the
// composer while a turn is running, mirroring the queued follow-up header. Reads the
// same working-tree diff totals as the chat-header badge and offers a Review action
// that opens the diff panel. Hidden when there are no changes.
// Layer: Chat composer UI
// Exports: ComposerLiveChangesHeader

import { pluralize } from "@t3tools/shared/text";
import { memo } from "react";

import { ChangesIcon } from "~/lib/icons";
import {
  ComposerStackedPanelRow,
  ComposerStackedPanelRowLabel,
  ComposerStackedPanelRowMain,
} from "./ComposerStackedPanelContent";
import { ComposerStackedPanel } from "./ComposerStackedPanel";
import { COMPOSER_STACKED_PANEL_ICON_CLASS_NAME } from "./composerStackedPanelStyles";
import { DiffStatLabel } from "./DiffStatLabel";
import { ReviewChangesButton } from "./ReviewChangesButton";

interface ComposerLiveChangesHeaderProps {
  fileCount: number;
  additions: number;
  deletions: number;
  onReview: () => void;
  attachedToPrevious?: boolean;
}

export const ComposerLiveChangesHeader = memo(function ComposerLiveChangesHeader({
  fileCount,
  additions,
  deletions,
  onReview,
  attachedToPrevious = false,
}: ComposerLiveChangesHeaderProps) {
  if (fileCount === 0) {
    return null;
  }

  return (
    <ComposerStackedPanel attachedToPrevious={attachedToPrevious}>
      <ComposerStackedPanelRow>
        <ComposerStackedPanelRowMain>
          <ChangesIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
          <ComposerStackedPanelRowLabel>
            {`${fileCount} ${pluralize(fileCount, "file")} changed`}
          </ComposerStackedPanelRowLabel>
          {additions + deletions > 0 ? (
            <span className="shrink-0 tabular-nums">
              <DiffStatLabel additions={additions} deletions={deletions} />
            </span>
          ) : null}
        </ComposerStackedPanelRowMain>
        <ReviewChangesButton onClick={onReview} />
      </ComposerStackedPanelRow>
    </ComposerStackedPanel>
  );
});
