// Purpose: Sidebar group slots — the group wrapper, label, action, and content.
// Layer: ui primitive (shadcn sidebar). No sidebar-context dependency.
// Exports: SidebarGroup, SidebarGroupLabel, SidebarGroupAction, SidebarGroupContent.
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import * as React from "react";
import { cn } from "~/lib/utils";

export function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("relative flex w-full min-w-0 flex-col p-2", className)}
      data-sidebar="group"
      data-slot="sidebar-group"
      {...props}
    />
  );
}

export function SidebarGroupLabel({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">) {
  const defaultProps = {
    className: cn(
      "flex h-8 shrink-0 items-center rounded-lg px-2 font-medium text-sidebar-foreground text-xs outline-hidden ring-ring/60 transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-1 [&>svg]:size-4 [&>svg]:shrink-0",
      "group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
      className,
    ),
    "data-sidebar": "group-label",
    "data-slot": "sidebar-group-label",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps(defaultProps, props),
    render,
  });
}

export function SidebarGroupAction({
  className,
  render,
  ...props
}: useRender.ComponentProps<"button">) {
  const defaultProps = {
    className: cn(
      "absolute top-3.5 right-3 flex aspect-square w-5 items-center justify-center rounded-lg p-0 text-sidebar-foreground outline-hidden ring-ring/60 transition-transform hover:bg-[var(--sidebar-accent)] focus-visible:ring-1 [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0",
      // Increases the hit area of the button on mobile.
      "after:-inset-2 after:absolute md:after:hidden",
      "group-data-[collapsible=icon]:hidden",
      className,
    ),
    "data-sidebar": "group-action",
    "data-slot": "sidebar-group-action",
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps(defaultProps, props),
    render,
  });
}

export function SidebarGroupContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("w-full text-sm", className)}
      data-sidebar="group-content"
      data-slot="sidebar-group-content"
      {...props}
    />
  );
}
