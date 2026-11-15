// FILE: RowHoverActions.tsx
// Purpose: Absolutely positioned action strip that a row reveals on hover or highlight.
// Layer: UI primitive shared by sidebar rows and picker menu rows
// Exports: RowHoverActions

import type { ComponentProps } from "react";
import { cn } from "~/lib/utils";
import { hoverRevealShowClassName, type HoverActionsGroup } from "~/rowHoverReveal";

/** The row needs `relative` and the matching `group/<row>` marker. */
export function RowHoverActions({
  group,
  className,
  ...props
}: ComponentProps<"div"> & { group: HoverActionsGroup }) {
  return (
    <div
      {...props}
      className={cn(
        "absolute inset-y-0 right-0 my-auto inline-flex items-center",
        hoverRevealShowClassName(group),
        className,
      )}
    />
  );
}
