// FILE: PickerPanelShell.tsx
// Purpose: Share the visual shell used by combobox-style pickers in chat surfaces.
// Layer: Chat picker UI
// Depends on: shared input styling plus caller-provided content slots.

import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { Input } from "../ui/input";

export function PickerPanelShell(props: {
  searchPlaceholder?: string;
  query?: string;
  onQueryChange?: (query: string) => void;
  stopSearchKeyPropagation?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  widthClassName?: string;
  bleedParentPadding?: boolean;
}) {
  const {
    searchPlaceholder = "Search",
    query = "",
    onQueryChange,
    stopSearchKeyPropagation = false,
    children,
    footer,
    widthClassName = "w-72",
    bleedParentPadding = false,
  } = props;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        widthClassName,
        bleedParentPadding ? "-m-1 overflow-clip rounded-xl" : null,
      )}
    >
      {onQueryChange ? (
        <div
          className={cn(
            "sticky z-20 border-b border-border bg-[var(--composer-surface)] p-1",
            bleedParentPadding ? "-top-1 pt-2" : "top-0",
          )}
        >
          <Input
            className="rounded-md border-border/60 bg-background shadow-none before:hidden has-focus-visible:border-neutral-500/15 has-focus-visible:ring-0 [&_input]:font-sans"
            nativeInput
            size="sm"
            type="search"
            placeholder={searchPlaceholder}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDownCapture={
              stopSearchKeyPropagation ? (event) => event.stopPropagation() : undefined
            }
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1">{children}</div>
      {footer ? <div className="border-t p-1">{footer}</div> : null}
    </div>
  );
}
