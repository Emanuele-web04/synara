// FILE: SegmentedPicker.tsx
// Purpose: The app's segmented control, as a radio group with arrow-key selection.
//          "capsule" is a rounded track with a sliding pill for switching between
//          equal views; "buttons" is a row of plain options for tab-like rows, the
//          selected one on a soft fill. "sm" is the dense size of tool panels (the canvas
//          inspector); `iconOnly` shows each option's icon with its label as the tooltip;
//          `shape="field"` squares the capsule off to the radius of the dense fields beside it.
// Layer: Shared presentation
// Exports: SegmentedPicker, SegmentedPickerOption

import type { CSSProperties, ReactNode } from "react";

import { useRadioGroupKeyboardNav } from "~/hooks/useRadioGroupKeyboardNav";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface SegmentedPickerOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
  readonly title?: string;
  /** With `iconOnly`: the tooltip's content (a label with its shortcut); defaults to the title or label. */
  readonly tooltip?: ReactNode;
}

/** Equal cells inside the track's inset (0.25rem, 0.125rem at "sm"); the pill covers the selected one. */
function pillGeometry(index: number, count: number, inset: string): CSSProperties {
  const cell = `(100% - 2 * ${inset}) / ${count}`;
  return { left: `calc(${inset} + ${index} * ${cell})`, width: `calc(${cell})` };
}

export function SegmentedPicker<T extends string>({
  value,
  options,
  onValueChange,
  ariaLabel,
  disabled: disabledProp,
  variant: variantProp,
  size: sizeProp,
  iconOnly: iconOnlyProp,
  shape: shapeProp,
  className,
}: {
  /** `null` selects nothing (a mixed value); the first option then takes the tab stop. */
  value: T | null;
  options: ReadonlyArray<SegmentedPickerOption<T>>;
  onValueChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  variant?: "capsule" | "buttons";
  size?: "default" | "sm";
  /** Show only each option's icon; its label names it and shows as a tooltip. */
  iconOnly?: boolean;
  /**
   * The capsule's corners: `pill` (round) or `field`, the small radius and soft secondary fill
   * of the dense input fields it sits beside (the canvas inspector).
   */
  shape?: "pill" | "field";
  className?: string;
}) {
  const disabled = disabledProp ?? false;
  const variant = variantProp ?? "capsule";
  const small = (sizeProp ?? "default") === "sm";
  const iconOnly = iconOnlyProp ?? false;
  const enabledValues = options.filter((option) => !option.disabled).map((option) => option.value);
  const tabStop = value ?? enabledValues[0] ?? null;
  const radioItemProps = useRadioGroupKeyboardNav({
    values: enabledValues,
    value: tabStop as T,
    onValueChange,
  });
  const activeIndex = options.findIndex((option) => option.value === value);
  const capsule = variant === "capsule";
  const field = capsule && shapeProp === "field";

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        capsule
          ? cn(
              "relative isolate grid w-full",
              field
                ? "rounded-sm bg-[var(--color-background-button-secondary)]"
                : "rounded-full bg-black/[0.05] dark:bg-white/[0.07]",
              small ? "p-0.5" : "p-1",
            )
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
          className={cn(
            "pointer-events-none absolute z-0 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.12)] transition-[left] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none dark:shadow-none",
            field
              ? "rounded-[calc(var(--radius-sm)-2px)] dark:bg-white/[0.12]"
              : "rounded-full dark:bg-background",
            small ? "inset-y-0.5" : "inset-y-1",
          )}
          style={pillGeometry(activeIndex, options.length, small ? "0.125rem" : "0.25rem")}
        />
      ) : null}
      {options.map((option) => {
        const active = option.value === value;
        const button = (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={iconOnly ? option.label : undefined}
            disabled={disabled || option.disabled}
            title={iconOnly ? undefined : option.title}
            className={cn(
              "relative z-10 flex min-w-0 items-center justify-center gap-1.5 text-ui font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
              capsule
                ? cn("h-8 px-3", field ? "rounded-[calc(var(--radius-sm)-2px)]" : "rounded-full")
                : "h-8 rounded-lg px-3",
              small && cn("h-6 px-2 text-ui-sm", !capsule && "rounded-md"),
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              !capsule && (active ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.03]"),
            )}
            onClick={() => onValueChange(option.value)}
            {...radioItemProps(option.value)}
          >
            {option.icon}
            {iconOnly ? null : <span className="truncate">{option.label}</span>}
          </button>
        );
        if (!iconOnly) return button;
        return (
          <Tooltip key={option.value}>
            <TooltipTrigger render={button} />
            <TooltipPopup>{option.tooltip ?? option.title ?? option.label}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
