// Purpose: Sidebar toggle controls — the in-sidebar trigger and the header companion
//   trigger that surfaces only when the sidebar is hidden.
// Layer: ui primitive (shadcn sidebar). Depends on ui/sidebar.context for state.
// Exports: SidebarTrigger, SidebarHeaderTrigger.
import * as React from "react";
import { cn } from "~/lib/utils";
import { CentralIcon } from "~/lib/central-icons";
import { isElectron } from "~/env";
import { useAppSettings } from "~/appSettings";
import { Button } from "~/components/ui/button";
import { useSidebar } from "~/components/ui/sidebar.context";

export function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar();
  const { settings } = useAppSettings();
  const sidebarIconName =
    settings.sidebarSide === "right" ? "sidebar-hidden-right-wide" : "sidebar-hidden-left-wide";

  return (
    <Button
      className={cn("size-7", className)}
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      size="icon-xs"
      variant="ghost"
      {...props}
    >
      <CentralIcon name={sidebarIconName} />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
}

// Desktop headers lose access to the in-sidebar trigger after an off-canvas close,
// so this companion control reuses the same trigger and only appears when hidden.
export function SidebarHeaderTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { isMobile, open, toggleSidebar } = useSidebar();
  const { settings } = useAppSettings();

  if (!isMobile && open) {
    return null;
  }

  return (
    <SidebarTrigger
      className={cn(
        isElectron && !isMobile && settings.sidebarSide === "left" && "ml-[76px]",
        className,
      )}
      onClick={onClick}
      {...props}
    />
  );
}
