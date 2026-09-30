// FILE: RouteSurfaceHeader.tsx
// Purpose: The top bar of a full-page route (Kanban, Pull requests, Automations, Inbox):
//          a draggable strip that keeps clear of the desktop window controls, the sidebar
//          controls first, then the page's own content.
// Layer: Shared app component
// Exports: RouteSurfaceHeader

import type { ReactNode } from "react";

import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { cn } from "~/lib/utils";
import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "./chat/chatHeaderControls";
import { SidebarHeaderNavigationControls } from "./SidebarHeaderNavigationControls";

export function RouteSurfaceHeader({
  divider = true,
  windowControlsGutter = true,
  className,
  rowClassName,
  children,
}: {
  /** The hairline under the bar; a page that opens onto cards leaves it off. */
  divider?: boolean;
  /** Off for a left column whose right neighbor already clears the window controls. */
  windowControlsGutter?: boolean;
  className?: string | undefined;
  rowClassName?: string | undefined;
  children?: ReactNode;
}) {
  const trafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const windowControlsGutterClassName = useDesktopTopBarWindowControlsGutterClassName();
  return (
    <header
      className={cn(
        divider && CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
        CHAT_SURFACE_HEADER_PADDING_X_CLASS,
        "drag-region",
        trafficLightGutterClassName,
        windowControlsGutter && windowControlsGutterClassName,
        className,
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 sm:gap-3",
          CHAT_SURFACE_HEADER_HEIGHT_CLASS,
          rowClassName,
        )}
      >
        <SidebarHeaderNavigationControls />
        {children}
      </div>
    </header>
  );
}
