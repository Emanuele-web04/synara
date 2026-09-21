import { cn } from "~/lib/utils";
import type { ThreadStatusPill } from "./Sidebar.logic";

export function ThreadStatusPillChip({
  pill,
  className,
}: {
  pill: ThreadStatusPill;
  className?: string;
}) {
  return (
    <span
      className={cn("flex min-w-0 items-center gap-1.5 text-ui-sm", pill.colorClass, className)}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          pill.dotClass,
          pill.pulse ? "animate-pulse" : "",
        )}
      />
      <span className="truncate">{pill.label}</span>
    </span>
  );
}
