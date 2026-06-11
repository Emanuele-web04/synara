// Purpose: Sidebar menu family — list, items, buttons, actions, badges, skeletons, and
//   the nested sub-menu, plus the menu-button cva variants.
// Layer: ui primitive (shadcn sidebar). Depends on ui/sidebar.context for state.
// Exports: SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarMenuAction,
//   SidebarMenuBadge, SidebarMenuSkeleton, SidebarMenuSub, SidebarMenuSubItem,
//   SidebarMenuSubButton.
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "~/lib/utils";
import { Skeleton } from "~/components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useSidebar } from "~/components/ui/sidebar.context";

export function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      className={cn("flex w-full min-w-0 flex-col gap-1", className)}
      data-sidebar="menu"
      data-slot="sidebar-menu"
      {...props}
    />
  );
}

export function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      className={cn("group/menu-item relative", className)}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
      {...props}
    />
  );
}

const sidebarMenuButtonVariants = cva(
  "peer/menu-button flex w-full cursor-pointer items-center gap-2 overflow-hidden rounded-xl p-2 text-left text-sm outline-hidden ring-ring/60 transition-[width,height,padding] hover:bg-[var(--sidebar-accent)] focus-visible:ring-1 active:bg-[var(--sidebar-accent-active)] active:text-[var(--sidebar-accent-foreground)] disabled:pointer-events-none disabled:opacity-50 group-has-data-[sidebar=menu-action]/menu-item:pe-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-[var(--sidebar-accent-active)] data-[active=true]:font-medium data-[active=true]:text-[var(--sidebar-accent-foreground)] data-[state=open]:hover:bg-[var(--sidebar-accent)] group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-8 text-sm",
        lg: "h-12 text-sm group-data-[collapsible=icon]:p-0!",
        sm: "h-7 text-xs",
      },
      variant: {
        default: "hover:bg-[var(--sidebar-accent)]",
        outline:
          "bg-background shadow-[0_0_0_1px_var(--sidebar-border)] hover:bg-[var(--sidebar-accent)] hover:shadow-[0_0_0_1px_var(--sidebar-border)]",
      },
    },
  },
);

export function SidebarMenuButton({
  isActive = false,
  variant = "default",
  size = "default",
  tooltip,
  className,
  render,
  ...props
}: useRender.ComponentProps<"button"> & {
  isActive?: boolean;
  tooltip?: string | React.ComponentProps<typeof TooltipPopup>;
} & VariantProps<typeof sidebarMenuButtonVariants>) {
  const { isMobile, state } = useSidebar();

  const defaultProps = {
    className: cn(sidebarMenuButtonVariants({ size, variant }), className),
    "data-active": isActive,
    "data-sidebar": "menu-button",
    "data-size": size,
    "data-slot": "sidebar-menu-button",
  };

  const buttonProps = mergeProps<"button">(defaultProps, props);

  const buttonElement = useRender({
    defaultTagName: "button",
    props: buttonProps,
    render,
  });

  if (!tooltip) {
    return buttonElement;
  }

  if (typeof tooltip === "string") {
    tooltip = {
      children: tooltip,
    };
  }

  return (
    <Tooltip>
      <TooltipTrigger render={buttonElement as React.ReactElement<Record<string, unknown>>} />
      <TooltipPopup
        align="center"
        hidden={state !== "collapsed" || isMobile}
        side="right"
        {...tooltip}
      />
    </Tooltip>
  );
}

export function SidebarMenuAction({
  className,
  showOnHover = false,
  render,
  ...props
}: useRender.ComponentProps<"button"> & {
  showOnHover?: boolean;
}) {
  const defaultProps = {
    className: cn(
      "sidebar-icon-button absolute top-1.5 right-1 flex aspect-square w-5 cursor-pointer p-0 text-sidebar-foreground outline-hidden ring-ring/60 transition-transform [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0",
      // Increases the hit area of the button on mobile.
      "after:-inset-2 after:absolute md:after:hidden",
      "peer-data-[size=sm]/menu-button:top-1",
      "peer-data-[size=default]/menu-button:top-1.5",
      "peer-data-[size=lg]/menu-button:top-2.5",
      "group-data-[collapsible=icon]:hidden",
      showOnHover &&
        "group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-[state=open]:opacity-100 peer-data-[active=true]/menu-button:text-[var(--sidebar-accent-foreground)] md:opacity-0",
      className,
    ),
    "data-sidebar": "menu-action",
    "data-slot": "sidebar-menu-action",
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

export function SidebarMenuBadge({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute right-1 flex h-5 min-w-5 select-none items-center justify-center rounded-lg px-1 font-medium text-sidebar-foreground text-xs tabular-nums",
        "peer-data-[active=true]/menu-button:text-[var(--sidebar-accent-foreground)]",
        "peer-data-[size=sm]/menu-button:top-1",
        "peer-data-[size=default]/menu-button:top-1.5",
        "peer-data-[size=lg]/menu-button:top-2.5",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      data-sidebar="menu-badge"
      data-slot="sidebar-menu-badge"
      {...props}
    />
  );
}

export function SidebarMenuSkeleton({
  className,
  showIcon = false,
  ...props
}: React.ComponentProps<"div"> & {
  showIcon?: boolean;
}) {
  // Random width between 50 to 90%.
  const width = React.useMemo(() => {
    return `${Math.floor(Math.random() * 40) + 50}%`;
  }, []);

  return (
    <div
      className={cn("flex h-8 items-center gap-2 rounded-lg px-2", className)}
      data-sidebar="menu-skeleton"
      data-slot="sidebar-menu-skeleton"
      {...props}
    >
      {showIcon && <Skeleton className="size-4 rounded-lg" data-sidebar="menu-skeleton-icon" />}
      <Skeleton
        className="h-4 max-w-(--skeleton-width) flex-1"
        data-sidebar="menu-skeleton-text"
        style={
          {
            "--skeleton-width": width,
          } as React.CSSProperties
        }
      />
    </div>
  );
}

export function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      className={cn(
        "mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-sidebar-border border-l px-2.5 py-0.5",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      data-sidebar="menu-sub"
      data-slot="sidebar-menu-sub"
      {...props}
    />
  );
}

export function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      className={cn("group/menu-sub-item relative", className)}
      data-sidebar="menu-sub-item"
      data-slot="sidebar-menu-sub-item"
      {...props}
    />
  );
}

export function SidebarMenuSubButton({
  size = "md",
  isActive = false,
  className,
  render,
  ...props
}: useRender.ComponentProps<"a"> & {
  size?: "sm" | "md";
  isActive?: boolean;
}) {
  const defaultProps = {
    className: cn(
      "-translate-x-px flex h-7 min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2 text-sidebar-foreground outline-hidden ring-ring/60 hover:bg-[var(--sidebar-accent)] focus-visible:ring-1 active:bg-[var(--sidebar-accent-active)] active:text-[var(--sidebar-accent-foreground)] disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0",
      "data-[active=true]:bg-[var(--sidebar-accent-active)] data-[active=true]:text-[var(--sidebar-accent-foreground)]",
      size === "sm" && "text-xs",
      size === "md" && "text-sm",
      "group-data-[collapsible=icon]:hidden",
      className,
    ),
    "data-active": isActive,
    "data-sidebar": "menu-sub-button",
    "data-size": size,
    "data-slot": "sidebar-menu-sub-button",
  };

  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(defaultProps, props),
    render,
  });
}
