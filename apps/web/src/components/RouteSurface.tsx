// FILE: RouteSurface.tsx
// Purpose: The chrome full-width routes share (Tasks, Kanban): the chat-style surface column
//          and its draggable top bar with the sidebar navigation controls, where the caller's
//          title, counts, and controls sit in one no-drag row.
// Layer: Route UI component
// Exports: RouteSurface, RouteSurfaceHeader

import type { ReactNode } from "react";

import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
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
import { CHAT_BACKGROUND_CLASS_NAME } from "./chat/composerPickerStyles";

/** The route's column: header on top, its content filling the rest. */
export function RouteSurface({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        CHAT_BACKGROUND_CLASS_NAME,
      )}
    >
      {children}
    </div>
  );
}

/** Top bar: navigation controls, then the caller's title, counts, and controls in one row. */
export function RouteSurfaceHeader({ children }: { children: ReactNode }) {
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  return (
    <header
      className={cn(
        CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
        CHAT_SURFACE_HEADER_PADDING_X_CLASS,
        "drag-region",
        desktopTopBarTrafficLightGutterClassName,
        desktopTopBarWindowControlsGutterClassName,
      )}
    >
      <div className={cn("flex items-center gap-2 sm:gap-3", CHAT_SURFACE_HEADER_HEIGHT_CLASS)}>
        <SidebarHeaderNavigationControls />
        <div className="flex min-w-0 flex-1 items-center gap-2 [-webkit-app-region:no-drag]">
          {children}
        </div>
      </div>
    </header>
  );
}
