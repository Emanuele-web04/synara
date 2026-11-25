// FILE: SidebarRowHoverActions.tsx
// Purpose: Absolutely positioned hover action strip on thread/chat rows.
// Layer: Sidebar UI primitive
// Exports: SidebarRowHoverActions

import type { ReactNode } from "react";
import { RowHoverActions } from "./RowHoverActions";

export function SidebarRowHoverActions({
  threadId,
  children,
}: {
  threadId: string;
  children: ReactNode;
}) {
  return (
    <RowHoverActions group="thread-row" data-testid={`thread-hover-actions-${threadId}`}>
      {children}
    </RowHoverActions>
  );
}
