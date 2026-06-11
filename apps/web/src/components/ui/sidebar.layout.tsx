// Purpose: Structural sidebar shells — the root <Sidebar>, the content inset, and the
//   header/footer/content/input/separator slots.
// Layer: ui primitive (shadcn sidebar). Depends on ui/sidebar.context for state.
// Exports: Sidebar, SidebarInset, SidebarInput, SidebarHeader, SidebarFooter,
//   SidebarSeparator, SidebarContent.
import * as React from "react";
import { cn } from "~/lib/utils";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Separator } from "~/components/ui/separator";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import {
  type SidebarInstanceContextProps,
  type SidebarResizableOptions,
  type SidebarResolvedResizableOptions,
  SidebarInstanceContext,
  SIDEBAR_WIDTH_MOBILE,
  resolveSidebarResizable,
  useSidebar,
} from "~/components/ui/sidebar.context";

export function Sidebar({
  side = "left",
  variant = "sidebar",
  collapsible = "offcanvas",
  resizable = false,
  className,
  gapClassName,
  innerClassName,
  transparentSurface = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "left" | "right";
  variant?: "sidebar" | "floating" | "inset";
  collapsible?: "offcanvas" | "icon" | "none";
  resizable?: boolean | SidebarResizableOptions;
  gapClassName?: string;
  innerClassName?: string;
  transparentSurface?: boolean;
}) {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar();
  const resolvedResizable = React.useMemo<SidebarResolvedResizableOptions | null>(
    () => resolveSidebarResizable(resizable, { collapsible, isMobile }),
    [collapsible, isMobile, resizable],
  );
  const instanceContextValue = React.useMemo<SidebarInstanceContextProps>(
    () => ({ side, resizable: resolvedResizable }),
    [resolvedResizable, side],
  );

  if (collapsible === "none") {
    return (
      <SidebarInstanceContext.Provider value={instanceContextValue}>
        <div
          className={cn(
            "flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground",
            innerClassName,
            className,
          )}
          data-slot="sidebar"
          {...props}
        >
          {children}
        </div>
      </SidebarInstanceContext.Provider>
    );
  }

  if (isMobile) {
    return (
      <SidebarInstanceContext.Provider value={instanceContextValue}>
        <Sheet onOpenChange={setOpenMobile} open={openMobile} {...props}>
          <SheetPopup
            className={cn(
              "w-(--sidebar-width) max-w-none bg-sidebar p-0 text-sidebar-foreground",
              className,
            )}
            data-mobile="true"
            data-sidebar="sidebar"
            data-slot="sidebar"
            showCloseButton={false}
            side={side}
            style={
              {
                "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
              } as React.CSSProperties
            }
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Sidebar</SheetTitle>
              <SheetDescription>Displays the mobile sidebar.</SheetDescription>
            </SheetHeader>
            <div className={cn("flex h-full w-full flex-col", innerClassName)}>{children}</div>
          </SheetPopup>
        </Sheet>
      </SidebarInstanceContext.Provider>
    );
  }

  return (
    <SidebarInstanceContext.Provider value={instanceContextValue}>
      <div
        className="group peer hidden text-sidebar-foreground md:block"
        data-collapsible={state === "collapsed" ? collapsible : ""}
        data-side={side}
        data-slot="sidebar"
        data-state={state}
        data-variant={variant}
      >
        {/* This is what handles the sidebar gap on desktop */}
        <div
          className={cn(
            "relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear",
            "group-data-[collapsible=offcanvas]:w-0",
            "group-data-[side=right]:rotate-180",
            variant === "floating" || variant === "inset"
              ? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"
              : "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
            gapClassName,
          )}
          data-slot="sidebar-gap"
        />
        <div
          className={cn(
            "fixed inset-y-0 z-0 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear md:flex",
            side === "left"
              ? "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]"
              : "right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]",
            // Adjust the padding for floating and inset variants.
            variant === "floating" || variant === "inset"
              ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]"
              : cn(
                  "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
                  // Skip container border when innerClassName provides its own
                  !transparentSurface &&
                    "group-data-[side=left]:border-r group-data-[side=right]:border-l",
                ),
            className,
          )}
          data-slot="sidebar-container"
          {...props}
        >
          {/* The inner surface is the safe place for visual skinning. The outer shell owns
              fixed positioning, width transitions, and the resize rail hit area. */}
          <div
            className={cn(
              "relative z-0 flex h-full w-full flex-col group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow-sm/5",
              !transparentSurface && "bg-sidebar",
              innerClassName,
            )}
            data-sidebar="sidebar"
            data-slot="sidebar-inner"
          >
            {children}
          </div>
        </div>
      </div>
    </SidebarInstanceContext.Provider>
  );
}

export function SidebarInset({
  className,
  children,
  surfaceClassName,
  ...props
}: React.ComponentProps<"main"> & {
  surfaceClassName?: string;
}) {
  return (
    <main
      className={cn(
        // Keep caller layout classes on the outer shell so route-level height and
        // overflow constraints still apply after the inner-surface refactor.
        "relative flex min-h-0 min-w-0 w-full flex-1 flex-col bg-transparent",
        "md:peer-data-[variant=sidebar]:peer-data-[side=left]:peer-data-[state=expanded]:-ms-[var(--sidebar-width)]",
        "md:peer-data-[variant=sidebar]:peer-data-[side=left]:peer-data-[state=expanded]:w-[calc(100%+var(--sidebar-width))]",
        "md:peer-data-[variant=sidebar]:peer-data-[side=left]:peer-data-[state=expanded]:ps-[var(--sidebar-width)]",
        "md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-2 md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ms-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm/5",
        className,
      )}
      data-slot="sidebar-inset"
      {...props}
    >
      {/* Inner surface lives inside the content-box so rounded corners
          and bg are visible even when padding offsets the sidebar area. */}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col text-inherit",
          surfaceClassName ?? "bg-background",
        )}
        data-slot="sidebar-inset-surface"
      >
        {children}
      </div>
    </main>
  );
}

export function SidebarInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <Input
      className={cn("h-8 w-full bg-background shadow-none", className)}
      data-sidebar="input"
      data-slot="sidebar-input"
      {...props}
    />
  );
}

export function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2 p-2", className)}
      data-sidebar="header"
      data-slot="sidebar-header"
      {...props}
    />
  );
}

export function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2 p-2", className)}
      data-sidebar="footer"
      data-slot="sidebar-footer"
      {...props}
    />
  );
}

export function SidebarSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      className={cn("mx-2 w-auto bg-sidebar-border", className)}
      data-sidebar="separator"
      data-slot="sidebar-separator"
      {...props}
    />
  );
}

export function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <ScrollArea hideScrollbars className="h-auto min-h-0 flex-1">
      <div
        className={cn(
          "flex w-full min-w-0 flex-col gap-2 group-data-[collapsible=icon]:overflow-hidden",
          className,
        )}
        data-sidebar="content"
        data-slot="sidebar-content"
        {...props}
      />
    </ScrollArea>
  );
}
