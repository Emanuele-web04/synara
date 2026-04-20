// FILE: PickerPanelShell.tsx
// Purpose: Share the visual shell used by combobox-style pickers in chat surfaces.
// Layer: Chat picker UI
// Depends on: shared input styling plus caller-provided content slots.

import type { ReactNode } from "react";
import { Input } from "../ui/input";

export function PickerPanelShell(props: {
  searchPlaceholder?: string;
  query?: string;
  onQueryChange?: (query: string) => void;
  children: ReactNode;
  footer?: ReactNode;
  widthClassName?: string;
}) {
  const {
    searchPlaceholder = "Search",
    query = "",
    onQueryChange,
    children,
    footer,
    widthClassName = "w-72",
  } = props;

  return (
    <div className={`flex min-h-0 flex-col ${widthClassName}`}>
      {onQueryChange ? (
        <div className="border-b p-1">
          <Input
            className="rounded-md border-border/60 bg-background shadow-none before:hidden has-focus-visible:border-neutral-500/15 has-focus-visible:ring-0 [&_input]:font-sans"
            nativeInput
            size="sm"
            type="search"
            placeholder={searchPlaceholder}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1">{children}</div>
      {footer ? <div className="border-t p-1">{footer}</div> : null}
    </div>
  );
}
