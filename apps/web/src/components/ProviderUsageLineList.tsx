// FILE: ProviderUsageLineList.tsx
// Purpose: Shared provider-usage line renderer for settings cards and compact popovers.
// Keeps label/value/subtitle semantics consistent while allowing each surface its own density.

import type { OpenUsageUsageLine } from "~/lib/openUsageRateLimits";
import { cn } from "~/lib/utils";

type ProviderUsageLineListSurface = "settings" | "popover";

const SURFACE_CLASSES: Record<
  ProviderUsageLineListSurface,
  {
    item: string;
    row: string;
    label: string;
    value: string;
    subtitle: string;
  }
> = {
  settings: {
    item: "space-y-0.5",
    row: "flex items-center justify-between gap-2 text-xs",
    label: "font-medium text-foreground",
    value: "text-right tabular-nums text-muted-foreground",
    subtitle: "text-[11px] text-muted-foreground/80",
  },
  popover: {
    item: "space-y-0.5",
    row: "flex items-center justify-between gap-2 leading-tight",
    label: "text-[11px] font-medium text-foreground",
    value: "text-right text-[length:var(--app-font-size-chat-meta,10px)] text-muted-foreground",
    subtitle:
      "text-[length:var(--app-font-size-chat-meta,10px)] leading-tight text-muted-foreground/80",
  },
};

export function ProviderUsageLineList({
  className,
  lines,
  surface,
}: {
  className?: string | undefined;
  lines: ReadonlyArray<OpenUsageUsageLine>;
  surface: ProviderUsageLineListSurface;
}) {
  const classes = SURFACE_CLASSES[surface];

  return (
    <div className={cn("space-y-1.5", className)}>
      {lines.map((line) => (
        <div key={`${line.label}:${line.value}`} className={classes.item}>
          <div className={classes.row}>
            <span className={classes.label}>{line.label}</span>
            <span className={classes.value}>{line.value}</span>
          </div>
          {line.subtitle ? <div className={classes.subtitle}>{line.subtitle}</div> : null}
        </div>
      ))}
    </div>
  );
}
