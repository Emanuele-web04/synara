// FILE: count-badge.tsx
// Purpose: A small muted count beside a label (files in a diff scope, items in a group); renders
//          nothing for zero or an unknown count.
// Layer: UI primitive
// Exports: CountBadge

import { cn } from "~/lib/utils";

export function CountBadge({
  count,
  className,
}: {
  readonly count: number | undefined;
  readonly className?: string;
}) {
  if (typeof count !== "number" || count <= 0) return null;
  return (
    <span
      className={cn(
        "rounded-full bg-muted px-1.5 text-ui-xs font-medium text-muted-foreground tabular-nums",
        className,
      )}
    >
      {count}
    </span>
  );
}
