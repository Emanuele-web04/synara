// FILE: ProviderAccentColorControl.tsx
// Purpose: Swatch row for an account's optional accent color, shown as a dot on its icon.
// Layer: Settings UI components
// Depends on: account presentation helpers.

import {
  normalizeProviderAccentColor,
  PROVIDER_ACCENT_COLOR_SWATCHES,
} from "~/lib/providerInstancePresentation";
import { cn } from "~/lib/utils";

export function ProviderAccentColorControl(props: {
  value: string | undefined;
  /** `undefined` clears the accent. */
  onChange: (accentColor: string | undefined) => void;
  /** Names the account in each swatch's accessible label. */
  accountLabel: string;
}) {
  const selected = normalizeProviderAccentColor(props.value);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {PROVIDER_ACCENT_COLOR_SWATCHES.map((color) => {
        const isSelected = selected === color;
        return (
          <button
            key={color}
            type="button"
            aria-label={`Accent color ${color} for ${props.accountLabel}`}
            aria-pressed={isSelected}
            className={cn(
              "size-5 cursor-pointer rounded-full outline-none ring-offset-2 ring-offset-background transition-shadow focus-visible:ring-2 focus-visible:ring-ring/60",
              isSelected && "ring-2 ring-foreground/70",
            )}
            style={{ backgroundColor: color }}
            // Picking the selected swatch again clears it.
            onClick={() => props.onChange(isSelected ? undefined : color)}
          />
        );
      })}
      {selected ? (
        <button
          type="button"
          className="ms-1 cursor-pointer text-ui-sm text-muted-foreground hover:text-foreground"
          onClick={() => props.onChange(undefined)}
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}
