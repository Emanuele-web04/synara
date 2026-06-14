// FILE: ComposerLiveChangesHeader.tsx
// Purpose: Live file-changes strip stacked flush onto the top of the
// composer while a turn is running, mirroring the queued follow-up header. The
// caller supplies turn-scoped diff totals and the Review action target.
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
  fileCount: number | null;
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
  const label =
    fileCount === null ? "Files changed" : `${fileCount} ${pluralize(fileCount, "file")} changed`;

  return (
    <ComposerStackedPanel attachedToPrevious={attachedToPrevious}>
      <ComposerStackedPanelRow>
        <ComposerStackedPanelRowMain>
          <ChangesIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
          <ComposerStackedPanelRowLabel>{label}</ComposerStackedPanelRowLabel>
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
