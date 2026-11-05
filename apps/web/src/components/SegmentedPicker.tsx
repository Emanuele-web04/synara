// FILE: SegmentedPicker.tsx
// Purpose: The app's segmented control, as a radio group with arrow-key selection.
//          "capsule" is a rounded track with a sliding pill for switching between
//          equal views; "buttons" is a row of plain options for tab-like rows, the
//          selected one on a soft fill.
// Layer: Shared presentation
// Exports: SegmentedPicker, SegmentedPickerOption

import type { CSSProperties, ReactNode } from "react";

import { useRadioGroupKeyboardNav } from "~/hooks/useRadioGroupKeyboardNav";
import { cn } from "~/lib/utils";

export interface SegmentedPickerOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
  readonly title?: string;
}

/** Equal cells inside the track's 0.25rem inset; the pill covers the selected one. */
function pillGeometry(index: number, count: number): CSSProperties {
  const cell = `(100% - 0.5rem) / ${count}`;
  return { left: `calc(0.25rem + ${index} * ${cell})`, width: `calc(${cell})` };
}

export function SegmentedPicker<T extends string>({
  value,
  options,
  onValueChange,
  ariaLabel,
  disabled: disabledProp,
  variant: variantProp,
  className,
}: {
  value: T;
  options: ReadonlyArray<SegmentedPickerOption<T>>;
  onValueChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  variant?: "capsule" | "buttons";
  className?: string;
}) {
  const disabled = disabledProp ?? false;
  const variant = variantProp ?? "capsule";
  const radioItemProps = useRadioGroupKeyboardNav({
    values: options.filter((option) => !option.disabled).map((option) => option.value),
    value,
    onValueChange,
  });
  const activeIndex = options.findIndex((option) => option.value === value);
  const capsule = variant === "capsule";

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        capsule
          ? "relative isolate grid w-full rounded-full bg-black/[0.05] p-1 dark:bg-white/[0.07]"
          : "flex flex-wrap items-center gap-1",
        className,
      )}
      style={
        capsule ? { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` } : undefined
      }
    >
      {capsule && activeIndex >= 0 ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-1 z-0 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.12)] transition-[left] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none dark:bg-background dark:shadow-none"
          style={pillGeometry(activeIndex, options.length)}
        />
      ) : null}
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled || option.disabled}
            title={option.title}
            className={cn(
              "relative z-10 flex min-w-0 items-center justify-center gap-1.5 text-ui font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
              capsule ? "h-8 rounded-full px-3" : "h-8 rounded-lg px-3",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              !capsule && (active ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.03]"),
            )}
            onClick={() => onValueChange(option.value)}
            {...radioItemProps(option.value)}
          >
            {option.icon}
            <span className="truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
