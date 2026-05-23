// FILE: surfaceElevation.ts
// Purpose: Shared outer + inset shadow tokens for bordered elevated surfaces.
// Layer: UI styling helper

/** Matches Card and other rounded-2xl bordered surfaces. */
export const SURFACE_ELEVATION_2XL_SHADOW_CLASS_NAME =
  "shadow-xs/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]";
