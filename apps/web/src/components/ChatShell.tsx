import type { ComponentProps, CSSProperties } from "react";
import { CHAT_SURFACE_HEADER_HEIGHT_PX } from "@synara/shared/desktopChrome";
import { useAppSettings } from "~/appSettings";
import { EmptyChatBackdrop } from "./chat/EmptyChatBackdrop";
import { SidebarProvider } from "./ui/sidebar";

/** Local and remote content use the same shell surfaces and sidebar geometry. */
export function ChatShell({
  showAtmosphere = false,
  ...props
}: ComponentProps<typeof SidebarProvider> & { showAtmosphere?: boolean }) {
  const open = props.controls?.open ?? props.open ?? props.defaultOpen ?? true;
  const { settings } = useAppSettings();
  return (
    <SidebarProvider
      {...props}
      className="relative isolate h-svh overflow-hidden bg-[var(--app-rail-shell-background)]"
      style={{ "--app-top-strip-height": `${CHAT_SURFACE_HEADER_HEIGHT_PX}px` } as CSSProperties}
      data-sidebar-side="left"
      data-sidebar-layout="rail"
      data-shell-sidebar-state={open ? "expanded" : "collapsed"}
    >
      {showAtmosphere && settings.showAsciiBackground ? (
        <div aria-hidden="true" className="app-shell-atmosphere" data-shell-atmosphere="">
          <EmptyChatBackdrop style={settings.emptyChatBackdropStyle} placement="shell" />
        </div>
      ) : null}
      {props.children}
    </SidebarProvider>
  );
}
