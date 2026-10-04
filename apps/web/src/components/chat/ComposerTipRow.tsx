// FILE: ComposerTipRow.tsx
// Purpose: One-line tip strip above the composer: icon, message, one action pill, and a
// permanent dismiss. Mounts and unmounts like its sibling stacked panels (live changes,
// goal) rather than animating, so the rail never reserves space for a tip that is not showing.
// Layer: Chat composer UI
// Exports: ComposerTipRow

import type { ReactNode } from "react";

import { XIcon } from "~/lib/icons";
import { IconButton } from "../ui/icon-button";
import { COMPOSER_INLINE_ACTION_PILL_CLASS_NAME } from "./composerPickerStyles";
import { ComposerStackedPanel } from "./ComposerStackedPanel";
import {
  ComposerStackedPanelRow,
  ComposerStackedPanelRowLabel,
  ComposerStackedPanelRowMain,
} from "./ComposerStackedPanelContent";

interface ComposerTipRowProps {
  icon: ReactNode;
  message: ReactNode;
  actionLabel: string;
  onAction: () => void;
  onDismiss: () => void;
  actionDisabled?: boolean;
  attachedToPrevious?: boolean;
  testId: string;
}

export function ComposerTipRow({
  icon,
  message,
  actionLabel,
  onAction,
  onDismiss,
  actionDisabled,
  attachedToPrevious,
  testId,
}: ComposerTipRowProps) {
  return (
    <ComposerStackedPanel attachedToPrevious={attachedToPrevious ?? false} data-testid={testId}>
      <ComposerStackedPanelRow>
        <ComposerStackedPanelRowMain>
          {icon}
          <ComposerStackedPanelRowLabel>{message}</ComposerStackedPanelRowLabel>
        </ComposerStackedPanelRowMain>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className={COMPOSER_INLINE_ACTION_PILL_CLASS_NAME}
            disabled={actionDisabled}
            onClick={onAction}
          >
            {actionLabel}
          </button>
          <IconButton variant="ghost" size="icon-chip" label="Dismiss tip" onClick={onDismiss}>
            <XIcon />
          </IconButton>
        </div>
      </ComposerStackedPanelRow>
    </ComposerStackedPanel>
  );
}
