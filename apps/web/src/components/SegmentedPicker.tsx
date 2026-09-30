// FILE: SegmentedPicker.tsx
// Purpose: The raised-thumb segmented control (a recessed track with a sliding selected chip), as
//          a radio group with arrow-key selection, in a regular and a compact (toolbar) density.
//          Segments can carry an icon, a short label, and a count. Styling lives in index.css
//          (`.sidebar-segmented-picker`, `.sidebar-segmented-thumb`).
// Layer: Shared presentation
// Exports: SegmentedPicker, SegmentedPickerOption, SegmentedPickerDensity

import type { ReactNode } from "react";

import { useRadioGroupKeyboardNav } from "~/hooks/useRadioGroupKeyboardNav";
import { cn } from "~/lib/utils";

export interface SegmentedPickerOption<T extends string> {
  readonly value: T;
  readonly label: string;
  /** The compact picker shows this instead of `label` ("PRs"); `label` stays the name. */
  readonly shortLabel?: string;
  readonly icon?: ReactNode;
  /** A trailing count, such as how many rows the segment would show. */
  readonly count?: number;
  readonly disabled?: boolean;
  readonly title?: string;
}

/**
 * "regular": the full-width raised picker (a thumb that hangs past the track at either end).
 * "compact": a toolbar-sized picker that hugs its content, with equal segments, a flat thumb
 * inside a thin track, and small muted counts.
 */
export type SegmentedPickerDensity = "regular" | "compact";

/** How far the regular picker's selected chip hangs past the track at either end. */
const THUMB_OVERHANG = "5px";

function thumbGeometry(
  index: number,
  count: number,
  density: SegmentedPickerDensity,
): { left: string; width: string } {
  const cell = `(100% - 0.25rem) / ${count}`;
  const left = `calc(0.125rem + ${index} * (${cell}))`;
  if (density === "compact") return { left, width: `calc(${cell})` };
  const edgeWidth = `calc(${cell} + 0.125rem + 1px + ${THUMB_OVERHANG})`;
  if (index === 0) return { left: `calc(-1px - ${THUMB_OVERHANG})`, width: edgeWidth };
  return index === count - 1 ? { left, width: edgeWidth } : { left, width: `calc(${cell})` };
}

/** The regular picker's end chips are wider than their cell, so their labels shift half the
 *  extra outward to stay centred on the chip rather than the cell. */
function labelShift(index: number, count: number, density: SegmentedPickerDensity): string {
  if (density === "compact") return "0px";
  const extra = `(0.125rem + 1px + ${THUMB_OVERHANG}) / 2`;
  if (index === 0) return `calc(-1 * ${extra})`;
  return index === count - 1 ? `calc(${extra})` : "0px";
}

export function SegmentedPicker<T extends string>({
  value,
  options,
  onValueChange,
  ariaLabel,
  density: densityProp,
  disabled: disabledProp,
  className,
}: {
  value: T;
  options: ReadonlyArray<SegmentedPickerOption<T>>;
  onValueChange: (value: T) => void;
  ariaLabel: string;
  density?: SegmentedPickerDensity;
  disabled?: boolean;
  className?: string;
}) {
  const density = densityProp ?? "regular";
  const compact = density === "compact";
  const disabled = disabledProp ?? false;
  const radioItemProps = useRadioGroupKeyboardNav({
    values: options.filter((option) => !option.disabled).map((option) => option.value),
    value,
    onValueChange,
  });
  const activeIndex = options.findIndex((option) => option.value === value);
  const thumb = activeIndex >= 0 ? thumbGeometry(activeIndex, options.length, density) : null;

  return (
    <div className={cn(compact ? "inline-flex shrink-0" : "px-1", className)}>
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        className={cn(
          "sidebar-segmented-picker relative isolate p-0.5",
          // Compact segments share the widest one's width so the sliding thumb lines up.
          compact
            ? "inline-grid auto-cols-fr grid-flow-col rounded-md"
            : "inline-flex w-full rounded-lg",
        )}
      >
        {thumb ? (
          <div
            aria-hidden
            className={cn(
              "sidebar-segmented-thumb pointer-events-none absolute z-0 transition-[left,width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
              compact ? "inset-y-0.5 rounded-[5px]" : "-inset-y-[1.5px] rounded-md",
            )}
            style={thumb}
          />
        ) : null}
        {options.map((option, index) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={
                option.count === undefined ? undefined : `${option.label}, ${option.count}`
              }
              disabled={disabled || option.disabled}
              title={option.title}
              className={cn(
                "relative z-10 flex min-w-0 items-center justify-center font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
                compact
                  ? "h-[1.125rem] rounded-[5px] px-1.5 text-ui-xs"
                  : "flex-1 rounded-md px-2.5 py-1 text-ui-sm",
                active
                  ? "text-[var(--color-text-foreground)]"
                  : "text-[var(--color-text-foreground-secondary)] hover:text-[var(--color-text-foreground)]",
              )}
              onClick={() => onValueChange(option.value)}
              {...radioItemProps(option.value)}
            >
              <span
                className={cn(
                  "flex min-w-0 items-center transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
                  compact ? "gap-1" : "gap-1.5",
                )}
                style={{
                  transform: `translateX(${active ? labelShift(index, options.length, density) : "0px"})`,
                }}
              >
                {option.icon}
                <span className="truncate">
                  {compact && option.shortLabel ? option.shortLabel : option.label}
                </span>
                {option.count === undefined ? null : (
                  <span
                    className={cn(
                      "shrink-0 font-normal tabular-nums text-[var(--color-text-foreground-secondary)]",
                      compact && "text-ui-2xs opacity-80",
                    )}
                  >
                    {option.count}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
