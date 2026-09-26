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
    <header
      className={cn(
        // Zero intrinsic width: the column's width comes from the rail and panel only.
        "app-shell-top-strip drag-region flex w-0 min-w-full shrink-0 items-center overflow-hidden ps-4 pe-3 font-system-ui",
        CHAT_SURFACE_HEADER_HEIGHT_CLASS,
        isElectron && isMacNavigatorPlatform() && DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS,
      )}
    >
      {open ? <SidebarLeadingControls /> : null}
    </header>
  );
}
