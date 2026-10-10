// the sidebar mixed size-3/3.5/15px and raw react-icons; Tabler/Central vs react-icons/lu need different sizes at the same semantic slot — the one place to tune that

import type { ComponentType } from "react";
import { cn } from "~/lib/utils";

/** Tailwind classes per semantic icon slot in the sidebar chrome. */
export const SIDEBAR_GLYPH = {
  /** Primary nav + footer rows inside a `size-5` leading slot (New thread, Settings). */
  leading: "size-[15px] shrink-0",
  /** Square header/row icon buttons and thread identity glyphs (Tabler/Central). */
  chrome: "size-3.5 shrink-0",
  /** Same 20px buttons when the glyph is react-icons/lu (denser viewBox). */
  chromeLu: "size-3 shrink-0",
  /** Thread row meta badges (handoff, fork, temporary, worktree). */
  meta: "size-3 shrink-0",
  /** Subagent expand control chevrons. */
  chevron: "size-3 shrink-0",
  /** Compact archive control on subagent rows. */
  compact: "size-[11px] shrink-0",
  /** Tiny overlay badges (terminal count on provider avatar). */
  badge: "size-2.5 shrink-0",
} as const;

export type SidebarGlyphVariant = keyof typeof SIDEBAR_GLYPH;

// trailing icons share one optical size; Tailwind only scans literals so both forms are spelled out — the forced form targets Central's masked `<span>` too, not just <svg>
export const SIDEBAR_TRAILING_ICON_CLASS = "size-[15px] shrink-0";
export const SIDEBAR_TRAILING_ICON_FORCE_CLASS =
  "[&_svg]:size-[15px] [&_[data-slot=central-icon]]:size-[15px]";

export function sidebarGlyphClass(variant: SidebarGlyphVariant, className?: string) {
  return cn(SIDEBAR_GLYPH[variant], className);
}

export function SidebarGlyph({
  icon: Icon,
  variant,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  variant: SidebarGlyphVariant;
  className?: string;
}) {
  return <Icon className={sidebarGlyphClass(variant, className)} aria-hidden />;
}
