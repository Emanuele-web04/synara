/** Section titles (the Description / Checks / Comments disclosure headers). */
export const PR_SECTION_TITLE_TEXT_CLASS_NAME =
  "text-[length:calc(var(--app-font-size-ui-lg,13px)*1.16)]";

/** Emphasized copy one step above the UI base: row titles, markdown bodies, timeline entries. */
export const PR_BODY_TEXT_CLASS_NAME = "text-ui-lg";

/** Standard UI text: meta rows, section labels, descriptions, empty states. */
export const PR_META_TEXT_CLASS_NAME = "text-ui";

/** Fine print: timestamps, branch names, counters, file paths, group headers. */
export const PR_FINE_TEXT_CLASS_NAME = "text-ui-sm";

/** The ink for ambient metadata that frames a pull request without competing with it: author,
 *  repository, branch, relative time, diff counts, list group headers. `--muted-foreground` is
 *  the app's *secondary* tier (the runtime theme resolves it to ink at ~70%) — one step too
 *  present for a dense list, where it makes every row read as two equal lines. At 70% of that
 *  it lands on the tertiary tier the app already uses for placeholder and label text, so the
 *  title is the only thing with weight and the rest reads as texture. */
export const PR_QUIET_INK_CLASS_NAME = "text-muted-foreground/70";
