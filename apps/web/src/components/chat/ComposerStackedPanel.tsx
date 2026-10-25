// FILE: ComposerStackedPanel.tsx
// Purpose: Shared chrome for panels stacked above the composer input.
// Layer: Chat composer layout primitive
// Exports: ComposerStackedPanel and divider token for inner stacked-panel rows.

import { type HTMLAttributes, type ReactNode, type Ref } from "react";

import { cn } from "~/lib/utils";
import { ComposerStackedHeaderFrame } from "./ComposerColumnFrame";
import { COMPOSER_STACKED_PANEL_CHROME_CLASS_NAME } from "./composerStackedPanelStyles";

export { COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME } from "./composerStackedPanelStyles";

interface ComposerStackedPanelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
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
  borderless: borderlessProp,
  detached: detachedProp,
  ...rest
}: ComposerStackedPanelProps) {
  const borderless = borderlessProp ?? false;
  const detached = detachedProp ?? false;
  return (
    <ComposerStackedHeaderFrame
      ref={ref}
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
