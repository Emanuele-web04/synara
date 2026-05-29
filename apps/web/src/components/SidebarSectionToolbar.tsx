// FILE: SidebarSectionToolbar.tsx
// Purpose: Cluster of header actions beside a sidebar section title (Threads, Chats).
// Layer: Sidebar UI primitive
// Exports: SidebarSectionToolbar

import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function SidebarSectionToolbar({
  placement = "inline",
  className,
  children,
}: {
  /** `inline` = Threads header; `overlay` = Chats collapsible header (absolute). */
  placement?: "inline" | "overlay";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5",
        placement === "inline" ? "-mr-1" : "absolute top-1 right-1.5",
        className,
      )}
    >
      {children}
    </div>
  );
}
