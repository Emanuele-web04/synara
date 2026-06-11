// FILE: BrowserRuntimePreview.tsx
// Purpose: Skeleton placeholder shown while a restored browser pane hydrates its live webview.
// Layer: Desktop-only presentational React component
// Exports: BrowserRuntimePreview

import { Skeleton } from "./ui/skeleton";

// Keeps a restored browser pane visually occupied while the live webview hydrates.
export function BrowserRuntimePreview(props: { title: string; detail: string }) {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-background/35 p-6"
      role="status"
      aria-live="polite"
    >
      <div className="w-full max-w-sm rounded-xl border border-border/60 bg-card/70 p-4 shadow-sm">
        <div className="mb-4 flex items-center gap-3">
          <Skeleton className="size-9 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/3 rounded-full" />
            <Skeleton className="h-2.5 w-full rounded-full" />
          </div>
        </div>
        <div className="space-y-2">
          <Skeleton className="h-20 w-full rounded-lg" />
          <div className="grid grid-cols-3 gap-2">
            <Skeleton className="h-8 rounded-md" />
            <Skeleton className="h-8 rounded-md" />
            <Skeleton className="h-8 rounded-md" />
          </div>
        </div>
        <div className="mt-4 min-w-0 text-center">
          <p className="text-xs font-medium text-foreground">Restoring browser</p>
          <p className="mt-1 truncate text-[11px] text-muted-foreground" title={props.detail}>
            {props.title}
          </p>
        </div>
      </div>
    </div>
  );
}
