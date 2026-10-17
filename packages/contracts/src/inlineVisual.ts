import { Schema } from "effect";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

/**
 * Inline visuals: what an agent publishes into its own thread with the
 * `synara_show_visual` gateway tool. Usually a component spec (see
 * inlineVisualSpec.ts) that clients draw with their own components; for a view
 * the spec cannot express, a self-contained HTML document that clients run in a
 * sandboxed desktop frame. The server stores the source and records a
 * small `visual.shown` activity; clients fetch the source by id.
 */
export const INLINE_VISUAL_TOOL_NAME = "synara_show_visual";
export const INLINE_VISUAL_ACTIVITY_KIND = "visual.shown";

/** Kept well under the 1 MiB gateway request limit, since JSON escaping can double HTML. */
export const INLINE_VISUAL_MAX_HTML_BYTES = 256 * 1024;
export const INLINE_VISUAL_MAX_TITLE_LENGTH = 120;
export const INLINE_VISUAL_MIN_HEIGHT = 80;
export const INLINE_VISUAL_MAX_HEIGHT = 1600;
export const INLINE_VISUAL_DEFAULT_HEIGHT = 320;

export const InlineVisualId = Schema.String.check(Schema.isPattern(/^vis_[0-9a-f]{32}$/));
export type InlineVisualId = typeof InlineVisualId.Type;

/** How the stored source is read: a component spec as JSON, or an HTML document. */
export const InlineVisualFormat = Schema.Literals(["components", "html"]);
export type InlineVisualFormat = typeof InlineVisualFormat.Type;

/** What the `visual.shown` activity carries. The source itself is fetched separately. */
export const InlineVisualActivityPayload = Schema.Struct({
  visualId: InlineVisualId,
  /** Absent on visuals recorded before component specs existed, which are all HTML. */
  format: Schema.optional(InlineVisualFormat),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(INLINE_VISUAL_MAX_TITLE_LENGTH)),
  /** The agent's expected height, reserved until the page reports its own. */
  height: Schema.Int.check(
    Schema.isBetween({ minimum: INLINE_VISUAL_MIN_HEIGHT, maximum: INLINE_VISUAL_MAX_HEIGHT }),
  ),
  byteLength: NonNegativeInt.check(Schema.isLessThanOrEqualTo(INLINE_VISUAL_MAX_HTML_BYTES)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});
export type InlineVisualActivityPayload = typeof InlineVisualActivityPayload.Type;

export const OrchestrationGetInlineVisualInput = Schema.Struct({
  threadId: ThreadId,
  visualId: InlineVisualId,
});
export type OrchestrationGetInlineVisualInput = typeof OrchestrationGetInlineVisualInput.Type;

export const OrchestrationGetInlineVisualResult = Schema.Struct({
  visualId: InlineVisualId,
  /** The stored source: the spec JSON or the HTML document, per the activity's format. */
  html: Schema.String,
});
export type OrchestrationGetInlineVisualResult = typeof OrchestrationGetInlineVisualResult.Type;

/**
 * The fenced block an agent writes in its reply to place a visual there, with
 * the visual id as its only line. Clients draw the visual in its place.
 */
export const INLINE_VISUAL_EMBED_FENCE = "synara-visual";
