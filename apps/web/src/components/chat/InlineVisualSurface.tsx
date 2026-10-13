// FILE: InlineVisualSurface.tsx
// Purpose: The shared frame and color helpers of native inline visual blocks: the rounded
//          surface with an optional title row, series colors and swatches, and tone colors.
// Layer: Chat transcript row content
// Exports: InlineVisualSurface, SeriesSwatch, seriesColor, toneTextClassName, toneColor

import type { InlineVisualTone } from "@synara/contracts";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * A block that needs an edge (charts, tables, cards) sits on this surface; prose
 * and stats sit directly on the chat background like the reply around them.
 */
export function InlineVisualSurface({
  title,
  aside,
  highlighted = false,
  className,
  children,
}: {
  readonly title?: string | undefined;
  readonly aside?: ReactNode;
  readonly highlighted?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "min-w-0 rounded-2xl border px-4 py-3.5",
        highlighted
          ? "border-[color:color-mix(in_srgb,var(--chart-accent)_55%,transparent)]"
          : "border-[color:var(--rule)]",
        className,
      )}
    >
      {title !== undefined || aside ? (
        <header className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          {title !== undefined ? <h4 className="m-0 text-chat font-medium">{title}</h4> : <span />}
          {aside}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** Series 1 is the theme accent; 2-6 come from the shared visual palette (set on the root). */
export function seriesColor(index: number): string {
  return `var(--series-${(index % 6) + 1})`;
}

export function SeriesSwatch({ index }: { readonly index: number }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ background: seriesColor(index) }}
    />
  );
}

export function toneColor(tone: InlineVisualTone | "info" | undefined): string | undefined {
  switch (tone) {
    case "accent":
    case "info":
      return "var(--chart-accent)";
    case "success":
      return "var(--success)";
    case "warning":
      return "var(--warning)";
    case "danger":
      return "var(--destructive)";
    default:
      return undefined;
  }
}

/** Readable text in a tone: the tone mixed toward the foreground, as page tags do. */
export function toneTextClassName(tone: InlineVisualTone | undefined): string {
  switch (tone) {
    case "accent":
      return "text-[color:color-mix(in_srgb,var(--chart-accent)_80%,var(--foreground))]";
    case "success":
      return "text-[color:color-mix(in_srgb,var(--success)_75%,var(--foreground))]";
    case "warning":
      return "text-[color:color-mix(in_srgb,var(--warning)_65%,var(--foreground))]";
    case "danger":
      return "text-[color:color-mix(in_srgb,var(--destructive)_80%,var(--foreground))]";
    default:
      return "text-muted-foreground";
  }
}
