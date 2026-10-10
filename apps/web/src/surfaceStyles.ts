// FILE: surfaceStyles.ts
// Purpose: Shared surface tokens for chrome that sits on the app background — the faint
//          filled material and the elevated hover treatment used by rows, chips, and menus.
// Layer: UI styling
// Exports: SOFT_SURFACE_FILL_CLASS_NAME, ELEVATED_HOVER_SURFACE_CLASS_NAME,
//          ELEVATED_HOVER_SURFACE_RAISED_TEXT_CLASS_NAME, MUTED_LABEL_TEXT_CLASS_NAME,
//          MUTED_LABEL_TEXT_COLOR, GLASS_RAISED_SURFACE_CLASS_NAME,
//          FLOATING_OVERLAY_SURFACE_CLASS_NAME

/**
 * Faint filled surface — the fill behind `soft` inputs (search fields) and the
 * grouped settings cards. Kept in one place so a filled box and a filled input
 * placed next to each other always read as the same material.
 *
 * It is a translucent overlay, so the rendered color follows whatever sits beneath
 * it (sidebar surface vs. settings surface); the material matches, not the pixel.
 */
export const SOFT_SURFACE_FILL_CLASS_NAME = "bg-foreground/2";

export const ELEVATED_HOVER_SURFACE_CLASS_NAME =
  "transition-colors hover:bg-[var(--color-background-elevated-secondary)]";

export const ELEVATED_HOVER_SURFACE_RAISED_TEXT_CLASS_NAME = `${ELEVATED_HOVER_SURFACE_CLASS_NAME} hover:text-foreground`;

/**
 * The app's muted label tone — secondary text that reads as chrome rather than
 * content: transcript tool-call / file rows, the "Worked for" and "Thinking"
 * headers, composer picker labels, the composer placeholder.
 *
 * The reference surface is the assistant message action bar (copy / branch / fork
 * and its timestamp, see `MessageActionButton`), which is the tone every other
 * quiet label in the transcript is read against.
 *
 * Deliberately the FULL `--muted-foreground`, not a faded slice of it: that token
 * is already translucent ink (`--color-text-foreground-secondary`, ~0.65 alpha),
 * so an extra opacity modifier on top dims it twice. In dark mode that second dim
 * pulls the text toward the background rather than lightening it, which reads as a
 * darker, muddier gray than the action bar right below it.
 */
export const MUTED_LABEL_TEXT_CLASS_NAME = "text-muted-foreground";

export const MUTED_LABEL_TEXT_COLOR = "var(--muted-foreground)";

/**
 * Opts a surface that paints an opaque fill of its own (a card, a filled control) into the
 * raised glass tint on a whole-window glass shell, so it does not read as a solid block on a
 * translucent window. Inert everywhere else; the rule lives in index.css.
 */
export const GLASS_RAISED_SURFACE_CLASS_NAME = "app-glass-raised";

/**
 * Marks a floating overlay (menu, picker, popover, tooltip, toast). It takes the shared
 * overlay fill from index.css, and on a translucent window the page is cut out from under it
 * (see lib/glassOverlayCutout.ts), which finds overlays by this class.
 */
export const FLOATING_OVERLAY_SURFACE_CLASS_NAME = "app-popup-surface";
