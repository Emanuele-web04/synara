// Tailwind only emits arbitrary-variant utilities written as full literals, so each density spells out values — a parameterized helper would silently drop the CSS

/** Cozy rhythm: roomier blocks for short read-only bodies (e.g. the environment recap). */
export const COMPACT_CHAT_MARKDOWN_COZY_CLASS_NAME = [
  "[&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
  "[&_ul]:my-1.5 [&_ol]:my-1.5",
  "[&_li]:my-0.5",
  "[&_pre]:my-2",
].join(" ");

/** Tight rhythm: minimal blocks for dense rows (e.g. queued follow-up previews). */
export const COMPACT_CHAT_MARKDOWN_TIGHT_CLASS_NAME = [
  "[&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
  "[&_ul]:my-1 [&_ol]:my-1",
  "[&_li]:my-0.5",
  "[&_pre]:my-1.5",
].join(" ");
