// FILE: ComposerComputerControlEffortHint.tsx
// Purpose: Composer tip suggesting Medium effort while a chat drives the desktop, with
// one-click apply and a permanent dismiss.
// Layer: Chat composer UI
// Exports: ComposerComputerControlEffortHint

import { useTranslation } from "~/i18n";
import { MonitorIcon } from "~/lib/icons";
import {
  COMPUTER_CONTROL_HINT_ACTION_LABEL_KEY,
  COMPUTER_CONTROL_HINT_MESSAGE_KEY,
} from "./composerComputerControlHint";
import { COMPOSER_STACKED_PANEL_ICON_CLASS_NAME } from "./composerStackedPanelStyles";
import { ComposerTipRow } from "./ComposerTipRow";

interface ComposerComputerControlEffortHintProps {
  onApply: () => void;
  onDismiss: () => void;
}

export function ComposerComputerControlEffortHint({
  onApply,
  onDismiss,
}: ComposerComputerControlEffortHintProps) {
  const { t } = useTranslation();
  return (
    <ComposerTipRow
      icon={<MonitorIcon aria-hidden="true" className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />}
      message={t(COMPUTER_CONTROL_HINT_MESSAGE_KEY)}
      actionLabel={t(COMPUTER_CONTROL_HINT_ACTION_LABEL_KEY)}
      onAction={onApply}
      onDismiss={onDismiss}
      testId="composer-computer-control-effort-hint"
    />
  );
}
