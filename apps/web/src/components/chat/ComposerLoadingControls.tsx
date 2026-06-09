// FILE: ComposerLoadingControls.tsx
// Purpose: Placeholder composer controls shown while provider models load.
// Layer: Chat composer presentation
// Exports: ComposerControlSkeleton, ComposerModelLoadingControl.

import { Skeleton } from "../ui/skeleton";
import { RefreshCwIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export function ComposerControlSkeleton(props: { widthClassName: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex h-8 shrink-0 items-center rounded-md border border-border/50 px-2",
        props.widthClassName,
      )}
    >
      <Skeleton className="h-3.5 w-full rounded-full" />
    </div>
  );
}

export function ComposerModelLoadingControl(props: { widthClassName: string }) {
  return (
    <div
      aria-label="Loading models"
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 rounded-md border border-border/50 px-2 text-muted-foreground",
        props.widthClassName,
      )}
    >
      <RefreshCwIcon aria-hidden="true" className="size-3.5 animate-spin" />
      <span className="truncate text-[length:var(--app-font-size-ui-xs,11px)]">Loading models</span>
    </div>
  );
}
