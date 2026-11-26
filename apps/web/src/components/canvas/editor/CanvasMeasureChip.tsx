// FILE: CanvasMeasureChip.tsx
// Purpose: The compact on-canvas label: a layer's type, its W × H, a position or a distance in
//          one tabular line (hover, selection, marquee count, drag and measure overlays).
//          Gesture overlays that draw without React fill the same markup with fillMeasureChip.
// Layer: Canvas editor UI
// Notes: Colours come from the `--canvas-chip*` / `--canvas-measure` tokens in index.css. They do
//        not follow the app theme because the chip sits on the user's frame content.

import type { CSSProperties } from "react";
import { cn } from "~/lib/utils";
import { CANVAS_SIZE_BADGE_ATTRIBUTE } from "./canvasPinPlacement";

type ChipVariant = "label" | "distance" | "badge";

const chipClassName = (variant: ChipVariant, className?: string) =>
  cn(
    "pointer-events-none absolute flex items-center whitespace-nowrap tabular-nums",
    variant === "label"
      ? "h-4 gap-1.5 rounded-[calc(var(--radius-sm)/2)] bg-(--canvas-chip) px-[5px] text-ui-xs leading-none text-(--canvas-chip-foreground)"
      : variant === "badge"
        ? // The selection-blue W × H badge under the selection.
          "h-4 gap-1.5 rounded-[calc(var(--radius-sm)/2)] bg-(--canvas-accent) px-[5px] text-ui-xs leading-none text-white"
        : "h-[13px] rounded-[calc(var(--radius-sm)/2)] bg-(--canvas-measure) px-[3px] text-ui-2xs leading-none text-white",
    className,
  );
const MUTED_CLASS_NAME = "text-(--canvas-chip-muted)";
const LABEL_CLASS_NAME = "max-w-60 truncate";

/** Marks a chip's value spans, which a gesture may rewrite while it previews. */
export const CHIP_META_ATTRIBUTE = "data-canvas-chip-meta";

export type MeasureChipContent = {
  leading?: string | undefined;
  label?: string | undefined;
  meta?: readonly string[];
};

export function CanvasMeasureChip({
  leading,
  label,
  meta = [],
  variant = "label",
  className,
  style,
}: MeasureChipContent & {
  /** `distance` is the smaller grey chip on a measure line. */
  variant?: ChipVariant;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={chipClassName(variant, className)}
      style={style}
      {...(variant === "badge" ? { [CANVAS_SIZE_BADGE_ATTRIBUTE]: "" } : {})}
    >
      {leading ? <span className={MUTED_CLASS_NAME}>{leading}</span> : null}
      {label ? <span className={LABEL_CLASS_NAME}>{label}</span> : null}
      {meta.map((value, index) => (
        <span
          key={value}
          {...{ [CHIP_META_ATTRIBUTE]: index }}
          className={variant === "badge" ? undefined : MUTED_CLASS_NAME}
        >
          {value}
        </span>
      ))}
    </div>
  );
}

/** The same chip drawn into an element outside React (a gesture's live layer). */
export function fillMeasureChip(element: HTMLElement, content: MeasureChipContent) {
  element.className = chipClassName("label");
  const parts: HTMLElement[] = [];
  const span = (text: string, className: string) => {
    const part = element.ownerDocument.createElement("span");
    part.className = className;
    part.textContent = text;
    parts.push(part);
  };
  if (content.leading) span(content.leading, MUTED_CLASS_NAME);
  if (content.label) span(content.label, LABEL_CLASS_NAME);
  for (const value of content.meta ?? []) span(value, MUTED_CLASS_NAME);
  element.replaceChildren(...parts);
}
