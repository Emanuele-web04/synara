"use client";

// FILE: slider.tsx
// Purpose: Shared accent-colored single-value slider primitive with optional step marks.
// Layer: Base UI component
// Exports: Slider

import { Slider as SliderPrimitive } from "@base-ui/react/slider";

import { cn } from "~/lib/utils";

type SliderProps = {
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  /** `default` is a settings-row slider; `large` is the chunky iOS-style control
   *  (thumb nearly flush with a tall track) used by the composer effort card. */
  size?: "default" | "large";
  /** Draw one dot per step so discrete scales (effort levels, sizes) read as a ladder. */
  showStepMarks?: boolean;
  className?: string;
  "aria-label": string;
  /** Spoken value for assistive tech; defaults to the numeric value. */
  getAriaValueText?: (value: number) => string;
  onValueChange: (value: number) => void;
};

function stepMarkPercents(min: number, max: number, step: number): number[] {
  if (!(max > min) || !(step > 0)) return [];
  const marks: number[] = [];
  for (let value = min; value <= max + Number.EPSILON; value += step) {
    marks.push(((value - min) / (max - min)) * 100);
  }
  return marks;
}

/**
 * Single-thumb slider on the app accent. The thumb is edge-aligned so it never
 * overhangs the track; step marks live in a matching inset rail so every dot
 * sits exactly under the thumb centre at that value.
 */
function Slider({
  value,
  min,
  max,
  step: stepProp,
  disabled,
  size: sizeProp,
  showStepMarks: showStepMarksProp,
  className,
  "aria-label": ariaLabel,
  getAriaValueText,
  onValueChange,
}: SliderProps) {
  const step = stepProp ?? 1;
  const size = sizeProp ?? "default";
  const showStepMarks = showStepMarksProp ?? false;
  const marks = showStepMarks ? stepMarkPercents(min, max, step) : [];
  const valuePercent = max > min ? ((value - min) / (max - min)) * 100 : 0;

  return (
    <SliderPrimitive.Root
      value={value}
      min={min}
      max={max}
      step={step}
      {...(disabled ? { disabled: true } : {})}
      thumbAlignment="edge"
      onValueChange={(nextValue) => {
        if (typeof nextValue === "number") onValueChange(nextValue);
      }}
      className={cn(
        "relative flex w-full touch-none select-none items-center data-disabled:cursor-not-allowed data-disabled:opacity-64",
        size === "large"
          ? "[--slider-mark-size:--spacing(1)] [--slider-thumb-size:--spacing(6)] [--slider-track-size:--spacing(5)]"
          : "[--slider-mark-size:--spacing(1)] [--slider-thumb-size:--spacing(5)] [--slider-track-size:--spacing(3)]",
        className,
      )}
      data-slot="slider"
    >
      <SliderPrimitive.Control className="flex w-full cursor-pointer items-center py-0.5 data-disabled:cursor-not-allowed">
        <SliderPrimitive.Track
          className="relative h-[var(--slider-track-size)] w-full overflow-visible rounded-full bg-[color-mix(in_srgb,var(--color-text-foreground)_14%,transparent)]"
          data-slot="slider-track"
        >
          <SliderPrimitive.Indicator
            className="rounded-full bg-[var(--color-text-accent)]"
            data-slot="slider-indicator"
          />
          {marks.length > 0 ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-[calc(var(--slider-thumb-size)/2)] right-[calc(var(--slider-thumb-size)/2)]"
            >
              {marks.map((percent) => (
                <span
                  key={percent}
                  className={cn(
                    "absolute top-1/2 size-[var(--slider-mark-size)] -translate-x-1/2 -translate-y-1/2 rounded-full",
                    percent <= valuePercent + Number.EPSILON
                      ? "bg-white/55"
                      : "bg-[color-mix(in_srgb,var(--color-text-foreground)_28%,transparent)]",
                  )}
                  style={{ left: `${percent}%` }}
                />
              ))}
            </span>
          ) : null}
          <SliderPrimitive.Thumb
            aria-label={ariaLabel}
            {...(getAriaValueText
              ? { getAriaValueText: (_formatted: string, next: number) => getAriaValueText(next) }
              : {})}
            className="size-[var(--slider-thumb-size)] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.35),0_0_0_1px_rgba(0,0,0,0.06)] outline-none transition-[scale] duration-100 has-focus-visible:ring-2 has-focus-visible:ring-[color:var(--color-border-focus)]/60 has-focus-visible:ring-offset-1 has-focus-visible:ring-offset-background data-dragging:scale-105"
            data-slot="slider-thumb"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
