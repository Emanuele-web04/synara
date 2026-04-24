// FILE: SidebarHeaderNavigationControls.tsx
// Purpose: Keeps the collapsed-sidebar trigger and Electron route arrows in one header cluster.
// Layer: Shared web shell chrome
// Depends on: Sidebar state plus AppNavigationButtons

import { AppNavigationButtons } from "./AppNavigationButtons";
import { SidebarHeaderTrigger, useSidebar } from "./ui/sidebar";

export function SidebarHeaderNavigationControls() {
  const { isMobile, open } = useSidebar();
  const triggerVisible = isMobile || !open;

  if (!triggerVisible) {
    return null;
  }

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <AppNavigationButtons className="ms-0" />
      <SidebarHeaderTrigger className="size-7 shrink-0" />
    </div>
  );
}
