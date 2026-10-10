// FILE: FilterPillGroup.tsx
// Purpose: Plain text pill group for list scope filters (chip background on the active
//          option only) — the pull requests involvement/state tabs and the Tasks filters.
// Layer: Shared list presentation
// Exports: FilterPillGroup

import { CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME } from "~/components/chat/chatHeaderControls";
import { cn } from "~/lib/utils";

export function FilterPillGroup<T extends string>({
  value,
  options,
  onChange,
  onIntent,
  ariaLabel,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  onIntent?: (value: T) => void;
  ariaLabel?: string;
}) {
  return (
    // Sized off the shared UI font var so the pills track the user's font-size setting like
    // every Button-based control.
    <div role="group" aria-label={ariaLabel} className="flex items-center gap-1 text-ui">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onFocus={() => onIntent?.(option.value)}
          onPointerEnter={() => onIntent?.(option.value)}
          onClick={() => onChange(option.value)}
          // Active uses the shared control-active token (real contrast in both modes) — the
          // elevated-secondary tint is a 2–4% hover wash and disappears on dark surfaces.
          className={cn(
            "rounded-md px-2.5 py-1 transition-colors",
            option.value === value
              ? CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
