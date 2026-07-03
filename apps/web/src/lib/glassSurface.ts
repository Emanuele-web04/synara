// FILE: glassSurface.ts
// Purpose: Shared frosted-glass surface chrome for floating live-editor cards.
// Layer: Web utility

/**
 * Frosted translucent card surface used by the element properties window and
 * the live-editor text annotation boxes. Single source so every floating
 * live-edit card reads as the same material in both light and dark mode.
 * Consumers add their own radius, padding, sizing, and text color.
 */
export const BROWSER_GLASS_SURFACE_CLASS_NAME =
  "border border-black/10 bg-white/50 shadow-[0_22px_70px_rgba(15,23,42,0.24),inset_0_1px_0_rgba(255,255,255,0.78)] backdrop-blur-2xl backdrop-saturate-150 dark:border-white/10 dark:bg-[#111315]/74 dark:shadow-[0_18px_60px_rgba(0,0,0,0.46),inset_0_1px_0_rgba(255,255,255,0.06)]";
