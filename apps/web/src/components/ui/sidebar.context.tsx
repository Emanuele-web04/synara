// Purpose: Shared sidebar state — constants, types, React contexts, the provider,
//   and resizable-option resolution. Imported by the other ui/sidebar.* modules.
// Layer: ui primitive (shadcn sidebar). No sibling-module imports here to avoid cycles.
// Exports: SIDEBAR_* constants, Sidebar*ContextProps / SidebarResizable* types,
//   SidebarContext, SidebarInstanceContext, useSidebar, SidebarProvider,
//   resolveSidebarResizable, SidebarInstanceProvider.
import * as React from "react";
import { cn } from "~/lib/utils";
import { useIsMobile } from "~/hooks/useMediaQuery";

export const SIDEBAR_COOKIE_NAME = "sidebar_state";
export const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
export const SIDEBAR_WIDTH = "16rem";
export const SIDEBAR_WIDTH_MOBILE = "calc(100vw - var(--spacing(3)))";
export const SIDEBAR_WIDTH_ICON = "3rem";
export const SIDEBAR_RESIZE_DEFAULT_MIN_WIDTH = 16 * 16;

type SidebarContextProps = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

export type SidebarResizableOptions = {
  maxWidth?: number;
  minWidth?: number;
  onResize?: (width: number) => void;
  shouldAcceptWidth?: (context: {
    currentWidth: number;
    nextWidth: number;
    rail: HTMLButtonElement;
    side: "left" | "right";
    sidebarRoot: HTMLElement;
    wrapper: HTMLElement;
  }) => boolean;
  storageKey?: string;
};

export type SidebarResolvedResizableOptions = {
  maxWidth: number;
  minWidth: number;
  onResize?: (width: number) => void;
  shouldAcceptWidth?: (context: {
    currentWidth: number;
    nextWidth: number;
    rail: HTMLButtonElement;
    side: "left" | "right";
    sidebarRoot: HTMLElement;
    wrapper: HTMLElement;
  }) => boolean;
  storageKey: string | null;
};

export type SidebarInstanceContextProps = {
  resizable: SidebarResolvedResizableOptions | null;
  side: "left" | "right";
};

export const SidebarContext = React.createContext<SidebarContextProps | null>(null);
export const SidebarInstanceContext = React.createContext<SidebarInstanceContextProps | null>(null);

export function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }

  return context;
}

export function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = React.useState(false);

  // This is the internal state of the sidebar.
  // We use openProp and setOpenProp for control from outside the component.
  const [_open, _setOpen] = React.useState(defaultOpen);
  const open = openProp ?? _open;
  const setOpen = React.useCallback(
    async (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === "function" ? value(open) : value;
      if (setOpenProp) {
        setOpenProp(openState);
      } else {
        _setOpen(openState);
      }

      // This sets the cookie to keep the sidebar state.
      await cookieStore.set({
        expires: Date.now() + SIDEBAR_COOKIE_MAX_AGE * 1000,
        name: SIDEBAR_COOKIE_NAME,
        path: "/",
        value: String(openState),
      });
    },
    [setOpenProp, open],
  );

  // Helper to toggle the sidebar.
  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open);
  }, [isMobile, setOpen]);

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = open ? "expanded" : "collapsed";

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      isMobile,
      open,
      openMobile,
      setOpen,
      setOpenMobile,
      state,
      toggleSidebar,
    }),
    [state, open, setOpen, isMobile, openMobile, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        className={cn(
          "group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar",
          className,
        )}
        data-slot="sidebar-wrapper"
        style={
          {
            "--sidebar-width": SIDEBAR_WIDTH,
            "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
            ...style,
          } as React.CSSProperties
        }
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

// Resolves user-facing resizable options into concrete bounds, or null when resizing
// is unavailable (mobile / non-collapsible / disabled). Shared by Sidebar and the
// detached content-seam rail so both agree on identical resize behavior.
export function resolveSidebarResizable(
  resizable: boolean | SidebarResizableOptions,
  { collapsible, isMobile }: { collapsible: "offcanvas" | "icon" | "none"; isMobile: boolean },
): SidebarResolvedResizableOptions | null {
  if (isMobile || collapsible === "none" || !resizable) {
    return null;
  }
  const options = typeof resizable === "boolean" ? {} : resizable;
  return {
    maxWidth: options.maxWidth ?? Number.POSITIVE_INFINITY,
    minWidth: options.minWidth ?? SIDEBAR_RESIZE_DEFAULT_MIN_WIDTH,
    storageKey: options.storageKey ?? null,
    ...(options.onResize ? { onResize: options.onResize } : {}),
    ...(options.shouldAcceptWidth ? { shouldAcceptWidth: options.shouldAcceptWidth } : {}),
  };
}

// Supplies the per-instance sidebar context (side + resolved resize options) to a
// SidebarRail rendered OUTSIDE its <Sidebar> — e.g. the content-seam rail, which must
// stack above the chat card. Without this the detached rail has no resize config and
// silently degrades to toggle-only (the "can't drag" regression). Provide the SAME
// `resizable`/`side` here as on the matching <Sidebar>. Must be used inside a SidebarProvider.
export function SidebarInstanceProvider({
  side,
  resizable,
  collapsible = "offcanvas",
  children,
}: {
  side: "left" | "right";
  resizable: boolean | SidebarResizableOptions;
  collapsible?: "offcanvas" | "icon" | "none";
  children: React.ReactNode;
}) {
  const { isMobile } = useSidebar();
  const resolvedResizable = React.useMemo(
    () => resolveSidebarResizable(resizable, { collapsible, isMobile }),
    [collapsible, isMobile, resizable],
  );
  const value = React.useMemo<SidebarInstanceContextProps>(
    () => ({ resizable: resolvedResizable, side }),
    [resolvedResizable, side],
  );
  return (
    <SidebarInstanceContext.Provider value={value}>{children}</SidebarInstanceContext.Provider>
  );
}
