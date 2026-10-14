/** Schema-bounded labels keep a complete final character when their tails are cut. */

/** Placed where a cut tail was, so truncated text reads as truncated. */
const TRUNCATION_MARKER = "…";

/**
 * `text` cut to `maxLength` *characters* with a marker in place of the tail, so
 * a truncated label reads as truncated rather than as a different value.
 *
 * The cut never lands between the halves of a surrogate pair: one half on its
 * own decodes to a replacement character, which would put a symbol in the
 * result that the source never displayed. Schema-bounded string fields use
 * JavaScript string length rather than a UTF-8 byte count.
 */
export function clampTextToLength(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let cut = maxLength - TRUNCATION_MARKER.length;
  const code = cut > 0 ? text.charCodeAt(cut - 1) : 0;
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${text.slice(0, Math.max(0, cut))}${TRUNCATION_MARKER}`;
}
