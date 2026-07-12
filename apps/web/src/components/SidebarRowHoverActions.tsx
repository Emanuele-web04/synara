// FILE: SidebarRowHoverActions.tsx
// Purpose: Inline hover action strip on thread/chat rows.
// Layer: Sidebar UI primitive
// Exports: SidebarRowHoverActions

import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function SidebarRowHoverActions({
  threadId,
  children,
}: {
  threadId: string;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={`thread-hover-actions-${threadId}`}
      className={cn(
        "pointer-events-none inline-flex max-w-0 shrink-0 items-center overflow-hidden opacity-0",
        "transition-[max-width,margin,opacity] duration-150 ease-out",
        "group-hover/thread-row:ml-1 group-hover/thread-row:max-w-[5rem] group-hover/thread-row:pointer-events-auto group-hover/thread-row:opacity-100",
        "group-focus-within/thread-row:ml-1 group-focus-within/thread-row:max-w-[5rem] group-focus-within/thread-row:pointer-events-auto group-focus-within/thread-row:opacity-100",
      )}
    >
      {children}
    </div>
  );
}
