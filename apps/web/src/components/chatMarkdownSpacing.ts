// FILE: chatMarkdownSpacing.ts
// Purpose: Single source of truth for ChatMarkdown block vertical-rhythm overrides on
// compact (non-body) surfaces. ChatMarkdown owns the block element set (p / ul / ol / li /
// pre); centralizing these density variants stops the selector set and the first/last
// paragraph edge reset from drifting across the recap panel, queued follow-up previews,
// and any future compact surface.
// Layer: Web chat presentation styling
// Exports: COMPACT_CHAT_MARKDOWN_COZY_CLASS_NAME, COMPACT_CHAT_MARKDOWN_TIGHT_CLASS_NAME

// Tailwind only emits an arbitrary-variant utility when the full token (e.g. `[&_p]:my-1.5`)
// appears as a literal in source, so each density spells out its values instead of building
// them from interpolated parts — a value-parameterized helper would silently drop the CSS.

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
