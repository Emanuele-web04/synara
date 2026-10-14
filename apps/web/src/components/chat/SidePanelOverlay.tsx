// FILE: SidePanelOverlay.tsx
// Purpose: The top-right overlay shell shared by the chat column's side panels (Environment,
//          Library, Project): the pinned wrapper, the raised card, and its open/close motion.
// Layer: Chat shell component
// Exports: SidePanelOverlay

import type { ReactNode } from "react";

import {
  ENVIRONMENT_PANEL_MOTION_CLASS,
  ENVIRONMENT_PANEL_OVERLAY_WRAPPER_CLASS_NAME,
  ENVIRONMENT_PANEL_SURFACE_CLASS_NAME,
} from "~/components/chat/composerPickerStyles";
import { useInPageGlassOverlay } from "~/hooks/useInPageGlassOverlay";
import { cn } from "~/lib/utils";

export interface SidePanelOverlayProps {
  open: boolean;
  /**
   * Docked insets the transcript beside the card; floating lays the card over it. A floating
   * card has that content cut out from under it on a glass window (see glassOverlayCutout.ts).
   */
  variant: "docked" | "floating";
  /** Extra classes for the wrapper pinned to the chat column's right edge. */
  className?: string | undefined;
  /** Sizing for the raised card; the shared surface, motion, and open state are applied here. */
  cardClassName?: string | undefined;
  /** Card content. */
  children: ReactNode;
  /** Chrome stacked under the card inside the wrapper (Environment's preview rail). */
  trailing?: ReactNode;
}

export function SidePanelOverlay({
  open,
  variant,
  className,
  cardClassName,
  children,
  trailing,
}: SidePanelOverlayProps) {
  const glassOverlayRef = useInPageGlassOverlay<HTMLDivElement>(variant === "floating");
  return (
    <div
      ref={glassOverlayRef}
      className={cn(ENVIRONMENT_PANEL_OVERLAY_WRAPPER_CLASS_NAME, className)}
      data-environment-panel-variant={variant}
      aria-hidden={!open}
      inert={!open}
    >
      <div
        className={cn(
          ENVIRONMENT_PANEL_SURFACE_CLASS_NAME,
          ENVIRONMENT_PANEL_MOTION_CLASS,
          "flex flex-col",
          cardClassName,
          open
            ? "pointer-events-auto translate-x-0 opacity-100"
            : "pointer-events-none translate-x-full opacity-0",
        )}
      >
        {children}
      </div>
      {trailing}
    </div>
  );
}
