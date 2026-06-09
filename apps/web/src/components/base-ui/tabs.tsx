"use client";

import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import * as React from "react";

import { cn } from "~/lib/utils";

type TabsProps = React.ComponentPropsWithoutRef<typeof BaseTabs.Root>;
type TabsListProps = React.ComponentPropsWithoutRef<typeof BaseTabs.List>;
type TabsTriggerProps = React.ComponentPropsWithoutRef<typeof BaseTabs.Tab>;
type TabsContentProps = React.ComponentPropsWithoutRef<typeof BaseTabs.Panel>;

const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(function Tabs(
  { className, ...props },
  ref,
) {
  return <BaseTabs.Root ref={ref} className={cn("flex flex-col gap-2", className)} {...props} />;
});

const TabsList = React.forwardRef<HTMLDivElement, TabsListProps>(function TabsList(
  { className, ...props },
  ref,
) {
  return (
    <BaseTabs.List ref={ref} className={cn("inline-flex items-center", className)} {...props} />
  );
});

const TabsTrigger = React.forwardRef<HTMLElement, TabsTriggerProps>(function TabsTrigger(
  { className, ...props },
  ref,
) {
  return (
    <BaseTabs.Tab
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});

const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(function TabsContent(
  { className, ...props },
  ref,
) {
  return <BaseTabs.Panel ref={ref} className={cn("outline-none", className)} {...props} />;
});

export { Tabs, TabsContent, TabsList, TabsTrigger };
