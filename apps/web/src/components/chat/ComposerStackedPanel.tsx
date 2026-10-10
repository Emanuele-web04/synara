import { type HTMLAttributes, type ReactNode, type Ref } from "react";

import { cn } from "~/lib/utils";
import { ComposerStackedHeaderFrame } from "./ComposerColumnFrame";
import { COMPOSER_STACKED_PANEL_CHROME_CLASS_NAME } from "./composerStackedPanelStyles";

export { COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME } from "./composerStackedPanelStyles";

interface ComposerStackedPanelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
  /** Removes the top radius so this panel visually merges into the one above it. */
  attachedToPrevious?: boolean;
  /** Lets clicks pass through the side margins to the transcript underneath. */
  passthroughSideMargins?: boolean;
  /** Drops the hairline outline, keeping only the translucent surface (empty-landing tray). */
  borderless?: boolean;
  /** Keeps a complete outline and bottom corners when separated from the input. */
  detached?: boolean;
}

/** Single owner for composer-stacked panel frame, border, radius, and surface chrome. */
export function ComposerStackedPanel({
  children,
  className,
  ref,
  attachedToPrevious: attachedToPreviousProp,
  passthroughSideMargins: passthroughSideMarginsProp,
  borderless: borderlessProp,
  detached: detachedProp,
  ...rest
}: ComposerStackedPanelProps) {
  const attachedToPrevious = attachedToPreviousProp ?? false;
  const passthroughSideMargins = passthroughSideMarginsProp ?? false;
  const borderless = borderlessProp ?? false;
  const detached = detachedProp ?? false;
  return (
    <ComposerStackedHeaderFrame
      ref={ref}
      passthroughSideMargins={passthroughSideMargins}
      data-composer-stacked-attached={attachedToPrevious ? "true" : undefined}
      className={cn(
        COMPOSER_STACKED_PANEL_CHROME_CLASS_NAME,
        detached && "mb-0 w-full rounded-b-[var(--composer-radius)]! border-b",
        borderless && "border-0",
        className,
      )}
      {...rest}
    >
      {children}
    </ComposerStackedHeaderFrame>
  );
}
