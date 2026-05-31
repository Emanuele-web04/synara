// FILE: surfaceElevation.ts
// Purpose: Shared shadow tokens for bordered elevated surfaces.
// Layer: UI styling helper

/** Outer drop shadow for bordered elevated surfaces. */
export const SURFACE_OUTER_SHADOW_CLASS_NAME = "shadow-xs/5";

/** Outer + inset edge highlight for rounded-2xl bordered surfaces (e.g. Card). */
export const SURFACE_ELEVATION_2XL_SHADOW_CLASS_NAME = `${SURFACE_OUTER_SHADOW_CLASS_NAME} relative before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]`;
