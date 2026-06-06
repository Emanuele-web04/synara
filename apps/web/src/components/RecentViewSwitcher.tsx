// FILE: RecentViewSwitcher.tsx
// Purpose: Render the transient Ctrl+Tab recent-view overlay.
// Layer: UI component
// Exports: RecentViewSwitcher plus item shape used by the chat route shell.

import {
  MessageCircleIcon,
  PinIcon,
  PlugIcon,
  SettingsIcon,
  TerminalSquareIcon,
  WindowIcon,
} from "../lib/icons";
import { cn } from "../lib/utils";
import type { RecentViewDisplayEntry } from "../recentViews.logic";

type RecentViewSwitcherIconKind = "thread" | "terminal" | "workspace" | "settings" | "plugins";

function RecentViewIcon(props: { kind: RecentViewSwitcherIconKind; className?: string }) {
  const className = cn("size-4", props.className);
  switch (props.kind) {
    case "terminal":
      return <TerminalSquareIcon className={className} aria-hidden="true" />;
    case "workspace":
      return <WindowIcon className={className} aria-hidden="true" />;
    case "settings":
      return <SettingsIcon className={className} aria-hidden="true" />;
    case "plugins":
      return <PlugIcon className={className} aria-hidden="true" />;
    case "thread":
      return <MessageCircleIcon className={className} aria-hidden="true" />;
  }
}

function iconKindForEntry(entry: RecentViewDisplayEntry): RecentViewSwitcherIconKind {
  if (entry.kind === "thread") {
    return entry.isTerminal ? "terminal" : "thread";
  }
  return entry.kind;
}

export function RecentViewSwitcher(props: {
  entries: ReadonlyArray<RecentViewDisplayEntry>;
  selectedIndex: number;
}) {
  if (props.entries.length === 0) {
    return null;
  }

  const selectedIndex =
    props.selectedIndex >= 0 && props.selectedIndex < props.entries.length
      ? props.selectedIndex
      : 0;

  return (
    <div className="pointer-events-none fixed inset-0 z-[90] flex items-start justify-center pt-[14vh]">
      <div
        role="listbox"
        aria-label="Recent views"
        aria-activedescendant={`recent-view-switcher-${selectedIndex}`}
        className="w-[min(34rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border/70 bg-popover/95 p-1.5 text-popover-foreground shadow-2xl shadow-black/30 backdrop-blur-xl"
      >
        {props.entries.map((entry, index) => {
          const selected = index === selectedIndex;
          return (
            <div
              key={entry.key}
              id={`recent-view-switcher-${index}`}
              role="option"
              aria-selected={selected}
              className={cn(
                "flex h-14 items-center gap-3 rounded-lg px-3 transition-colors",
                selected ? "bg-primary text-primary-foreground" : "text-foreground/88",
              )}
            >
              <div
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-md border",
                  selected
                    ? "border-primary-foreground/25 bg-primary-foreground/15"
                    : "border-border/80 bg-muted/60 text-muted-foreground",
                )}
              >
                <RecentViewIcon kind={iconKindForEntry(entry)} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium leading-5">{entry.title}</div>
                <div
                  className={cn(
                    "truncate text-xs leading-4",
                    selected ? "text-primary-foreground/72" : "text-muted-foreground",
                  )}
                >
                  {entry.subtitle}
                </div>
              </div>
              {entry.isPinned ? (
                <PinIcon
                  className={cn(
                    "size-3.5 shrink-0",
                    selected ? "text-primary-foreground/75" : "text-muted-foreground",
                  )}
                  aria-hidden="true"
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
