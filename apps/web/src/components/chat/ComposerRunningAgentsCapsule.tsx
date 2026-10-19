// FILE: ComposerPendingBackgroundWorkRow.tsx
// Purpose: Compact "waiting on background agents" capsule above the composer after the
// latest turn has settled while background subagents keep running.
// Layer: Chat composer UI
// Exports: ComposerPendingBackgroundWorkRow

import { pluralize } from "@synara/shared/text";

import { BotIcon } from "~/lib/icons";
import { ComposerCapsule } from "./ComposerCapsule";
import { COMPOSER_STACKED_PANEL_ICON_CLASS_NAME } from "./composerStackedPanelStyles";

interface ComposerPendingBackgroundWorkRowProps {
  count: number;
}

export function ComposerPendingBackgroundWorkRow({ count }: ComposerPendingBackgroundWorkRowProps) {
  return (
    <ComposerCapsule
      icon={<BotIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />}
      testId="pending-background-work-row"
    >
      Waiting on {count} background {pluralize(count, "agent")}
    </ComposerCapsule>
  );
}
