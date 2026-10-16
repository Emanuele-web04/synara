// FILE: ComposerTipRow.tsx
// Purpose: One-line tip capsule above the composer: icon, message, optional action pill,
// and dismiss. Mounts and unmounts like its sibling capsules (live changes, goal) rather
// than animating, so the capsule row never reserves space for a tip that is not showing.
// Layer: Chat composer UI
// Exports: ComposerTipRow

import type { ReactNode } from "react";

import { XIcon } from "~/lib/icons";
import { IconButton } from "../ui/icon-button";
import { COMPOSER_CAPSULE_ACTION_CLASS_NAME, ComposerCapsule } from "./ComposerCapsule";

interface ComposerTipRowBaseProps {
  icon: ReactNode;
  message: ReactNode;
  onDismiss: () => void;
  testId: string;
}

type ComposerTipRowProps = ComposerTipRowBaseProps &
  (
    | { actionLabel: string; onAction: () => void; actionDisabled?: boolean }
    | { actionLabel?: never; onAction?: never; actionDisabled?: never }
  );

export function ComposerTipRow({
  icon,
  message,
  actionLabel,
  onAction,
  onDismiss,
  actionDisabled,
  testId,
}: ComposerTipRowProps) {
  return (
    <ComposerCapsule
      icon={icon}
      testId={testId}
      actions={
        <>
          {actionLabel && onAction ? (
            <button
              type="button"
              className={COMPOSER_CAPSULE_ACTION_CLASS_NAME}
              disabled={actionDisabled}
              onClick={onAction}
            >
              {actionLabel}
            </button>
          ) : null}
          <IconButton
            variant="ghost"
            size="icon-chip"
            className="size-5 rounded-full sm:size-5"
            label="Dismiss tip"
            onClick={onDismiss}
          >
            <XIcon />
          </IconButton>
        </>
      }
    >
      {message}
    </ComposerCapsule>
  );
}
