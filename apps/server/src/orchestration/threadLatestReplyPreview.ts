// FILE: threadLatestReplyPreview.ts
// Purpose: Turns the stored head of a thread's newest assistant reply into the shell's
//          `latestReplyPreview`, the plain-text line list rows show under the title.
// Layer: Orchestration read model
// Exports: source limits for the SQLite lookup and formatThreadLatestReplyPreview

import { THREAD_LATEST_REPLY_PREVIEW_MAX_LENGTH } from "@synara/contracts";
import { markdownToPlainText, truncatePlainText } from "@synara/shared/markdownPlainText";
import { unicodeSafeEndOffset } from "@synara/shared/text";

/**
 * Characters of a reply read to build its preview: three times the preview, so Markdown markup
 * rarely leaves it short, while the per-thread text work stays small at list scale.
 */
export const THREAD_LATEST_REPLY_PREVIEW_SOURCE_LENGTH = 3 * THREAD_LATEST_REPLY_PREVIEW_MAX_LENGTH;

// Six JSON characters per UTF-16 code unit, plus one unit of Unicode lookahead and the quotes.
export const THREAD_LATEST_REPLY_PREVIEW_ENCODED_SOURCE_LENGTH =
  6 * (THREAD_LATEST_REPLY_PREVIEW_SOURCE_LENGTH + 1) + 2;

/** The stored message columns a preview reads. */
export interface ThreadLatestReplyPreviewSource {
  /** At most THREAD_LATEST_REPLY_PREVIEW_SOURCE_LENGTH characters from the start of the text. */
  readonly text: string;
  /** The stored text runs past `text`. */
  readonly textTruncated: boolean;
  /** A bounded JSON string prefix when SQLite TEXT cannot hold the original intact. */
  readonly encodedText: string | null;
  readonly encodedTextTruncated: boolean;
}

// Drop an escape cut by the SQL read limit. JSON.parse still validates the retained string.
const TRUNCATED_JSON_STRING_PREFIX =
  /^("(?:[^"\\]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*)(?:\\(?:u[\da-fA-F]{0,3})?)?$/u;

function decodeStoredText(encodedText: string, truncated: boolean): string | null {
  try {
    const prefix = truncated ? TRUNCATED_JSON_STRING_PREFIX.exec(encodedText)?.[1] : undefined;
    if (truncated && prefix === undefined) {
      return null;
    }
    const decoded: unknown = JSON.parse(prefix === undefined ? encodedText : `${prefix}"`);
    return typeof decoded === "string" ? decoded : null;
  } catch {
    return null;
  }
}

/** The `latestReplyPreview` for one stored reply, or undefined when nothing readable is left. */
export function formatThreadLatestReplyPreview(
  source: ThreadLatestReplyPreviewSource,
): string | undefined {
  let text = source.text;
  let truncated = source.textTruncated;
  // A malformed JSON prefix falls back to the TEXT column rather than failing the list.
  const decoded =
    source.encodedText === null
      ? null
      : decodeStoredText(source.encodedText, source.encodedTextTruncated);
  if (decoded !== null) {
    truncated =
      source.encodedTextTruncated || decoded.length > THREAD_LATEST_REPLY_PREVIEW_SOURCE_LENGTH;
    text = decoded.slice(
      0,
      unicodeSafeEndOffset(decoded, THREAD_LATEST_REPLY_PREVIEW_SOURCE_LENGTH),
    );
  }
  const plainText = markdownToPlainText(text);
  if (plainText.length === 0) {
    return undefined;
  }
  // A reply that runs past what was read always ends in an ellipsis, even when its markup
  // left the readable part short.
  return truncatePlainText(
    truncated ? `${plainText}…` : plainText,
    THREAD_LATEST_REPLY_PREVIEW_MAX_LENGTH,
  );
}
