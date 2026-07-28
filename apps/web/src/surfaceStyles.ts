// FILE: surfaceStyles.ts
// Purpose: Shared surface tokens for chrome that sits on the app background — the faint
//          filled material and the elevated hover treatment used by rows, chips, and menus.
// Layer: UI styling
// Exports: SOFT_SURFACE_FILL_CLASS_NAME, ELEVATED_HOVER_SURFACE_CLASS_NAME,
//          ELEVATED_HOVER_SURFACE_RAISED_TEXT_CLASS_NAME

/**
 * Faint filled surface — the fill behind `soft` inputs (search fields) and the
 * grouped settings cards. Kept in one place so a filled box and a filled input
 * placed next to each other always read as the same material.
 *
 * It is a translucent overlay, so the rendered color follows whatever sits beneath
 * it (sidebar surface vs. settings surface); the material matches, not the pixel.
 */
export const SOFT_SURFACE_FILL_CLASS_NAME = "bg-foreground/2";

/**
 * Hover treatment for anything that raises off its surface on pointer-over: menu
 * items, picker triggers, row affordances, icon buttons, chips. One policy so every
 * hoverable surface in the app lights up with the same color and timing.
 */
export const ELEVATED_HOVER_SURFACE_CLASS_NAME =
  "transition-colors hover:bg-[var(--color-background-elevated-secondary)]";

/**
 * {@link ELEVATED_HOVER_SURFACE_CLASS_NAME} plus the text raise, for controls that rest
 * in a muted tone and come up to full foreground on hover (drag handles, link chips,
 * toolbar icon buttons).
 */
export const ELEVATED_HOVER_SURFACE_RAISED_TEXT_CLASS_NAME = `${ELEVATED_HOVER_SURFACE_CLASS_NAME} hover:text-foreground`;
