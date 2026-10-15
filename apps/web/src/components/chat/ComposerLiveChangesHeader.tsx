// FILE: ComposerLiveChangesHeader.tsx
// Purpose: Live file-changes capsule above the composer while a turn is running. The
// caller supplies turn-scoped diff totals (or a null count before they land) and the
// Review action target; clicking the capsule opens the review.
// Layer: Chat composer UI
// Exports: ComposerLiveChangesHeader

import { pluralize } from "@synara/shared/text";

import { ChangesIcon } from "~/lib/icons";
import { ComposerCapsule } from "./ComposerCapsule";
import { COMPOSER_STACKED_PANEL_ICON_CLASS_NAME } from "./composerStackedPanelStyles";
import { DiffStatLabel } from "./DiffStatLabel";

interface ComposerLiveChangesHeaderProps {
  fileCount: number | null;
  additions: number;
  deletions: number;
  // Explicit `| undefined` (not just `?`) so callers can pass a conditionally-absent
  // handler under exactOptionalPropertyTypes; the capsule is static when omitted.
  onReview?: (() => void) | undefined;
}

export function ComposerLiveChangesHeader({
  fileCount,
  additions,
  deletions,
  onReview,
}: ComposerLiveChangesHeaderProps) {
  if (fileCount === 0) {
    return null;
  }
  const filesLabel =
    fileCount === null ? "Files changed" : `${fileCount} ${pluralize(fileCount, "file")} changed`;

  return (
    <ComposerCapsule
      icon={<ChangesIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />}
      title={onReview ? `${filesLabel} · Review changes` : filesLabel}
      onClick={onReview}
      testId="composer-live-changes"
    >
      Changes
      {additions + deletions > 0 ? (
        <span className="ml-1.5 tabular-nums">
          <DiffStatLabel additions={additions} deletions={deletions} />
        </span>
      ) : null}
    </ComposerCapsule>
  );
}
