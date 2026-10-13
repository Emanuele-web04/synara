// FILE: ComposerPendingBackgroundWorkRow.tsx
// Purpose: Compact "waiting on background agents" row stacked above the composer
// after the latest turn has settled while background subagents keep running.
// Layer: Chat composer UI
// Exports: ComposerPendingBackgroundWorkRow

import { pluralize } from "~/i18n/pluralize";

import { BotIcon } from "~/lib/icons";
import { ComposerStackedPanel } from "./ComposerStackedPanel";
import { COMPOSER_STACKED_PANEL_FOOTER_ROW_CLASS_NAME } from "./composerStackedPanelStyles";
import { useTranslation } from "~/i18n";

interface ComposerPendingBackgroundWorkRowProps {
  count: number;
  attachedToPrevious?: boolean;
}

export function ComposerPendingBackgroundWorkRow({
  count,
  attachedToPrevious: attachedToPreviousProp,
}: ComposerPendingBackgroundWorkRowProps) {
  const { t } = useTranslation();

  const attachedToPrevious = attachedToPreviousProp ?? false;
  return (
    <ComposerStackedPanel
      passthroughSideMargins
      attachedToPrevious={attachedToPrevious}
      data-testid="pending-background-work-row"
    >
      <div className={COMPOSER_STACKED_PANEL_FOOTER_ROW_CLASS_NAME}>
        <div className="flex min-w-0 items-center gap-1.5">
          <BotIcon className="size-3 shrink-0" />
          <span className="truncate">
            {t("Waiting on")} {count} {t("background")} {pluralize(count, "agent")}
          </span>
        </div>
      </div>
    </ComposerStackedPanel>
  );
}
