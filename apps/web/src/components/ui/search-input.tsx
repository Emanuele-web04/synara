// FILE: search-input.tsx
// Purpose: General-purpose search input — the standard Input with a leading
//          magnifier icon (e.g. "Search files...", "Search settings...").
// Layer: UI primitives

import { forwardRef } from "react";

import { SearchIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Input, type InputProps } from "./input";

export const SearchInput = forwardRef<HTMLInputElement, InputProps>(function SearchInput(
  { className, type = "text", size = "sm", variant = "soft", ...props },
  ref,
) {
  return (
    <div className="relative w-full">
      <Input
        ref={ref}
        type={type}
        size={size}
        variant={variant}
        className={cn("[&>[data-slot=input]]:pl-8", className)}
        {...props}
      />
      <SearchIcon
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70"
        aria-hidden="true"
      />
    </div>
  );
});
