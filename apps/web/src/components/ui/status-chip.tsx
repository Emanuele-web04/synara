// FILE: status-chip.tsx
// Purpose: Shared status visuals: the bare StatusDot every status indicator draws, the
//          StatusChip that pairs it with a label (Tasks pills, kanban card thread status),
//          and the ink status glyphs use for marks cut out of a solid disc.
// Layer: UI primitive
// Exports: StatusDot, StatusChip, STATUS_GLYPH_CUTOUT_STROKE

import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";

// On-fill ink for glyphs painted as solid discs: the surface colour, so the mark reads as a
// cut-out in both themes.
export const STATUS_GLYPH_CUTOUT_STROKE = "var(--color-background-surface, white)";

/**
 * The 6px status dot. Callers pass the colour (`bg-*`) through `className`; `pulse` marks
 * live work. Remaining props (role, aria-*, title, data-*) land on the span.
 */
export function StatusDot({
  pulse = false,
  className,
  ...props
}: ComponentProps<"span"> & {
  pulse?: boolean;
}) {
  return (
    <span
      className={cn("size-1.5 shrink-0 rounded-full", pulse && "animate-pulse", className)}
      {...props}
    />
  );
}

const statusChipVariants = cva("flex items-center gap-1.5", {
  variants: {
    variant: {
      /** Tinted capsule that names what an agent is doing. */
      pill: "h-5.5 shrink-0 rounded-full px-2 text-ui-xs font-medium",
      /** Bare dot + text for dense meta rows; the label truncates instead of wrapping. */
      inline: "min-w-0 text-ui-sm",
    },
  },
  defaultVariants: { variant: "inline" },
});

export function StatusChip({
  variant,
  dotClassName = "bg-current",
  pulse = false,
  className,
  children,
}: VariantProps<typeof statusChipVariants> & {
  /** Dot colour; follows the label's text colour unless the status colours them apart. */
  dotClassName?: string;
  pulse?: boolean;
  /** Text colour (and, for `pill`, the tint) plus any layout override. */
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <span className={cn(statusChipVariants({ variant }), className)}>
      <StatusDot aria-hidden className={dotClassName} pulse={pulse} />
      {children}
    </span>
  );
}
