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
import { cn } from "~/lib/utils";
import { ComposerStackedHeaderFrame } from "./ComposerColumnFrame";
import { COMPOSER_SURFACE_BORDER_CLASS_NAME } from "./composerPickerStyles";
import { DiffStatLabel } from "./DiffStatLabel";
import { ReviewChangesButton } from "./ReviewChangesButton";

interface ComposerLiveChangesHeaderProps {
  fileCount: number;
  additions: number;
  deletions: number;
  onReview: () => void;
}

export const ComposerLiveChangesHeader = memo(function ComposerLiveChangesHeader({
  fileCount,
  additions,
  deletions,
  onReview,
}: ComposerLiveChangesHeaderProps) {
  if (fileCount === 0) {
    return null;
  }

  return (
    <ComposerStackedHeaderFrame
      className={cn(
        "chat-composer-surface chat-composer-stacked-top relative z-[1] flex items-center gap-2 overflow-hidden border border-b-0 px-3 pt-2.5 pb-2.5 text-[12px]",
        COMPOSER_SURFACE_BORDER_CLASS_NAME,
        // Soften the strip's border in dark mode so the 11/12 rail reads lighter
        // against the dark composer surface (light mode keeps the defined border).
        "dark:border-[color:color-mix(in_srgb,var(--color-border-heavy)_50%,transparent)]",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <ChangesIcon className="size-3.5 shrink-0 text-[var(--color-text-foreground-secondary)]" />
        <span className="truncate font-medium text-foreground/85">
          {`${fileCount} ${pluralize(fileCount, "file")} changed`}
        </span>
        {additions + deletions > 0 ? (
          <span className="shrink-0 tabular-nums">
            <DiffStatLabel additions={additions} deletions={deletions} />
          </span>
        ) : null}
      </div>
      <ReviewChangesButton onClick={onReview} />
    </ComposerStackedHeaderFrame>
  );
});
