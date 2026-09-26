// FILE: AppShellTopStrip.tsx
// Purpose: The rail layout's window-chrome strip over the rail and panel: drag region,
//          traffic-light gutter, and the leading chrome cluster (sidebar toggle + route
//          arrows). Route headers own the band to its right; with the panel collapsed the
//          strip narrows to the rail and the route header shows the cluster instead.
// Layer: App shell component

import { isElectron } from "~/env";
import { DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS } from "~/hooks/useDesktopTopBarGutter";
import { cn, isMacNavigatorPlatform } from "~/lib/utils";
import { CHAT_SURFACE_HEADER_HEIGHT_CLASS } from "./chat/chatHeaderControls";
import { SidebarLeadingControls } from "./SidebarHeaderNavigationControls";
import { useSidebar } from "./ui/sidebar";

export function AppShellTopStrip() {
  // Like the classic sidebar header: the cluster leaves with the panel, and the route
  // header's copy (SidebarHeaderNavigationControls) takes over while it is collapsed.
  const { open } = useSidebar();
  return (
    // Zero intrinsic width: the column's width comes from the rail and panel only. The
    // padding (including the traffic-light gutter) lives on the inner row, because a box's
    // own padding still counts toward its width and would widen the column past the rail
    // while the panel is collapsed.
    <header
      className={cn(
        "drag-region flex w-0 min-w-full shrink-0 overflow-hidden font-system-ui",
        CHAT_SURFACE_HEADER_HEIGHT_CLASS,
      )}
    >
      <div
        className={cn(
          "app-shell-top-strip flex shrink-0 items-center ps-4 pe-3",
          isElectron && isMacNavigatorPlatform() && DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS,
        )}
      >
        {open ? <SidebarLeadingControls /> : null}
      </div>
    </header>
  );
}
