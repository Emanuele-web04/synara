// FILE: sidebarGlyphs.tsx
// Purpose: Shared sidebar icon size scale and glyph renderer.
// Layer: Sidebar UI primitive
// Exports: SIDEBAR_GLYPH, SidebarGlyph, sidebarGlyphClass, type SidebarGlyphVariant
// Why: The sidebar mixed size-3, size-3.5, size-[15px], and raw react-icons without a
//      single optical scale. Tabler/Central vs react-icons/lu need different Tailwind
//      sizes at the same semantic slot — this module is the one place to tune that.

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

// Trailing thread-row icons (meta chips, pin, archive) share one optical size so the
// right-side cluster reads as a uniform set. Tailwind can only scan literal class strings,
// so the plain and slot-forced forms are spelled out here; keep their px values in step —
// this is the single place to retune the trailing-icon size.
//
// The forced form targets BOTH `<svg>` glyphs (lucide / react-icons) and Central icons,
// which render as a masked `<span data-slot=central-icon>` rather than an svg — without the
// second selector those (e.g. the worktree glyph) keep their smaller base size and look off.
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
