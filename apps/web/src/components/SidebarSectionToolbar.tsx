// FILE: SidebarSectionToolbar.tsx
// Purpose: Cluster of header actions beside a sidebar section or project title.
// Layer: Sidebar UI primitive
// Exports: SidebarSectionToolbar

import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function SidebarSectionToolbar({
  placement = "inline",
  revealOnHover = false,
  className,
  children,
}: {
  /** `inline` = Threads section header; `overlay` = Chats/project collapsible headers. */
  placement?: "inline" | "overlay";
  /** Fade in on `group/project-header` hover/focus (project rows only). */
  revealOnHover?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5",
        placement === "inline" ? "-mr-1" : "absolute top-1 right-1.5",
        revealOnHover &&
          "pointer-events-none opacity-100 transition-opacity md:opacity-0 md:group-hover/project-header:pointer-events-auto md:group-hover/project-header:opacity-100 md:group-has-[:focus-visible]/project-header:pointer-events-auto md:group-has-[:focus-visible]/project-header:opacity-100 md:has-[[data-state=open]]:pointer-events-auto md:has-[[data-state=open]]:opacity-100",
        className,
      )}
    >
      {children}
    </div>
  );
}
