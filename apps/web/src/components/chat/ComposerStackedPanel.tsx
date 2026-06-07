// FILE: ComposerStackedPanel.tsx
// Purpose: Shared chrome for panels stacked above the composer input.
// Layer: Chat composer layout primitive
// Exports: ComposerStackedPanel and divider token for inner stacked-panel rows.

import { memo, type HTMLAttributes, type ReactNode, type Ref } from "react";

import { cn } from "~/lib/utils";
import { ComposerStackedHeaderFrame } from "./ComposerColumnFrame";
import { COMPOSER_STACKED_SURFACE_BORDER_CLASS_NAME } from "./composerPickerStyles";

export const COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME = `border-t ${COMPOSER_STACKED_SURFACE_BORDER_CLASS_NAME}`;

interface ComposerStackedPanelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
  /** Removes the top radius so this panel visually merges into the one above it. */
  attachedToPrevious?: boolean;
  /** Lets clicks pass through the side margins to the transcript underneath. */
  passthroughSideMargins?: boolean;
}

/** Single owner for composer-stacked panel frame, border, radius, and surface chrome. */
export const ComposerStackedPanel = memo(function ComposerStackedPanel({
  children,
  className,
  ref,
  attachedToPrevious = false,
  passthroughSideMargins = false,
  ...rest
}: ComposerStackedPanelProps) {
  return (
    <ComposerStackedHeaderFrame
      ref={ref}
      passthroughSideMargins={passthroughSideMargins}
      data-composer-stacked-attached={attachedToPrevious ? "true" : undefined}
      className={cn(
        "chat-composer-surface chat-composer-stacked-top relative z-[1] overflow-hidden border border-b-0",
        COMPOSER_STACKED_SURFACE_BORDER_CLASS_NAME,
        className,
      )}
      {...rest}
    >
      {children}
    </ComposerStackedHeaderFrame>
  );
});
