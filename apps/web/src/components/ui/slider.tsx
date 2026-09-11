"use client";

// FILE: slider.tsx
// Purpose: Shared accent-colored single-value slider primitive with optional step marks.
// Layer: Base UI component
// Exports: Slider

import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { useEffect, useState } from "react";

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
  /** Animate the thumb and fill between stops with a short overshooting ease so a
   *  stepped slider feels like it snaps to a magnet instead of teleporting. Leave
   *  off for continuous scales, where the lag would fight the pointer. */
  magnetic?: boolean;
  className?: string;
  "aria-label": string;
  /** Spoken value for assistive tech; defaults to the numeric value. */
  getAriaValueText?: (value: number) => string;
  onValueChange: (value: number) => void;
};

// Snap motion: quick, with a touch of overshoot so the thumb visibly "lands" on the
// stop. Base UI positions the thumb via `inset-inline-start` and sizes the fill via
// `width`, so those are the transitioned properties.
const MAGNETIC_MOTION_CLASS =
  "transition-[inset-inline-start,width] duration-180 ease-[cubic-bezier(0.22,1.1,0.36,1)] motion-reduce:transition-none";

function stepMarkPercents(min: number, max: number, step: number): number[] {
  if (!(max > min) || !(step > 0)) return [];
  const marks: number[] = [];
  for (let value = min; value <= max + Number.EPSILON; value += step) {
    marks.push(((value - min) / (max - min)) * 100);
  }
  return marks;
}

// The pointer can leave the slider mid-drag (Base UI captures the pointer, but the
// cursor shown still follows the element under it), so the closed hand is forced
// document-wide for the duration of the press.
function useGrabbingCursor(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    const previous = root.style.cursor;
    root.style.cursor = "grabbing";
    return () => {
      root.style.cursor = previous;
    };
  }, [active]);
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
  magnetic: magneticProp,
  className,
  "aria-label": ariaLabel,
  getAriaValueText,
  onValueChange,
}: SliderProps) {
  const step = stepProp ?? 1;
  const size = sizeProp ?? "default";
  const showStepMarks = showStepMarksProp ?? false;
  const magnetic = magneticProp ?? false;
  const marks = showStepMarks ? stepMarkPercents(min, max, step) : [];
  const valuePercent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  const [pressed, setPressed] = useState(false);
  useGrabbingCursor(pressed);

  useEffect(() => {
    if (!pressed) return;
    const release = () => setPressed(false);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, [pressed]);

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
        "group/slider relative flex w-full touch-none select-none items-center data-disabled:cursor-not-allowed data-disabled:opacity-64",
        size === "large"
          ? "[--slider-mark-size:--spacing(1)] [--slider-thumb-size:--spacing(6)] [--slider-track-size:--spacing(5)]"
          : "[--slider-mark-size:--spacing(1)] [--slider-thumb-size:--spacing(5)] [--slider-track-size:--spacing(3)]",
        className,
      )}
      data-slot="slider"
      {...(pressed ? { "data-pressed": "" } : {})}
    >
      <SliderPrimitive.Control
        className="flex w-full cursor-grab items-center py-0.5 group-data-pressed/slider:cursor-grabbing data-disabled:cursor-not-allowed"
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return;
          setPressed(true);
        }}
      >
        <SliderPrimitive.Track
          className="relative h-[var(--slider-track-size)] w-full overflow-visible rounded-full bg-[color-mix(in_srgb,var(--color-text-foreground)_14%,transparent)]"
          data-slot="slider-track"
        >
          <SliderPrimitive.Indicator
            className={cn(
              "rounded-full bg-[var(--color-text-accent)]",
              magnetic && MAGNETIC_MOTION_CLASS,
            )}
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
                    "absolute top-1/2 size-[var(--slider-mark-size)] -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-180 motion-reduce:transition-none",
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
            className={cn(
              "size-[var(--slider-thumb-size)] cursor-grab rounded-full outline-none has-focus-visible:ring-2 has-focus-visible:ring-[color:var(--color-border-focus)]/40 has-focus-visible:ring-offset-1 has-focus-visible:ring-offset-background group-data-pressed/slider:cursor-grabbing",
              magnetic && MAGNETIC_MOTION_CLASS,
            )}
            data-slot="slider-thumb"
          >
            {/* Press feedback scales this inner disc, not the Thumb: Base UI measures the
                Thumb's bounding box to place it, so scaling it would shift the thumb off
                the track edge and expose the fill behind it. */}
            <span
              aria-hidden="true"
              className="block size-full rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.12),0_0_0_0.5px_rgba(0,0,0,0.05)] transition-[scale,box-shadow] duration-150 ease-out group-data-pressed/slider:scale-105 group-data-pressed/slider:shadow-[0_2px_5px_rgba(0,0,0,0.14),0_0_0_0.5px_rgba(0,0,0,0.05)] motion-reduce:transition-none"
            />
          </SliderPrimitive.Thumb>
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
