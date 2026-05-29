// FILE: SidebarProjectHeaderAction.tsx
// Purpose: Hover-revealed create-thread action button rendered inside sidebar project headers.
// Layer: Sidebar UI primitive
// Exports: SidebarProjectHeaderAction
// Why: The terminal/disposable/new-thread buttons were three near-identical
//      Tooltip + SidebarMenuAction blocks differing only by icon, label, tooltip,
//      horizontal offset, and click handler. This collapses them into one variant-driven button.

import type { ComponentType, MouseEvent, ReactNode } from "react";
import { cn } from "~/lib/utils";
import { type SidebarGlyphVariant, sidebarGlyphClass } from "./sidebarGlyphs";
import { SidebarMenuAction } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function SidebarProjectHeaderAction({
  icon: Icon,
  label,
  tooltip,
  offsetClassName,
  glyph = "chrome",
  iconClassName,
  testId,
  onClick,
}: {
  // Accepts both our LucideIcon adapters and raw react-icons glyphs.
  icon: ComponentType<{ className?: string }>;
  label: string;
  tooltip: ReactNode;
  // Horizontal placement only; vertical/size/hover behavior is shared.
  offsetClassName: string;
  /** Optical scale for the glyph; use `chromeLu` for react-icons/lu. */
  glyph?: SidebarGlyphVariant;
  iconClassName?: string;
  testId?: string;
  onClick: (event: MouseEvent<HTMLButtonElement> | MouseEvent) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuAction
            render={<button type="button" aria-label={label} data-testid={testId} />}
            showOnHover
            className={cn("sidebar-icon-button top-1.5 size-5 p-0", offsetClassName)}
            onClick={onClick}
          >
            <Icon className={iconClassName ?? sidebarGlyphClass(glyph)} />
          </SidebarMenuAction>
        }
      />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
