// FILE: ComposerComputerControlEffortHint.tsx
// Purpose: Composer tip suggesting Medium effort while a chat drives the desktop, with
// one-click apply and a permanent dismiss.
// Layer: Chat composer UI
// Exports: ComposerComputerControlEffortHint

import { MonitorIcon } from "~/lib/icons";
import {
  COMPUTER_CONTROL_HINT_ACTION_LABEL,
  COMPUTER_CONTROL_HINT_MESSAGE,
} from "./composerComputerControlHint";
import { COMPOSER_STACKED_PANEL_ICON_CLASS_NAME } from "./composerStackedPanelStyles";
import { ComposerTipRow } from "./ComposerTipRow";

interface ComposerComputerControlEffortHintProps {
  onApply: () => void;
  onDismiss: () => void;
  attachedToPrevious?: boolean;
}

export function ComposerComputerControlEffortHint({
  onApply,
  onDismiss,
  attachedToPrevious,
}: ComposerComputerControlEffortHintProps) {
  return (
    <ComposerTipRow
      icon={<MonitorIcon aria-hidden="true" className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />}
      message={COMPUTER_CONTROL_HINT_MESSAGE}
      actionLabel={COMPUTER_CONTROL_HINT_ACTION_LABEL}
      onAction={onApply}
      onDismiss={onDismiss}
      attachedToPrevious={attachedToPrevious ?? false}
      testId="composer-computer-control-effort-hint"
    />
  );
}
