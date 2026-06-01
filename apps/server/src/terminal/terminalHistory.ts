// Terminal scrollback caps. A redrawing full-screen TUI repaints via cursor-move
// escapes with almost no newlines, so a line-only cap lets the byte size grow
// without bound. We additionally enforce a hard UTF-8 byte ceiling and trim only
// on replay-safe boundaries so xterm replay never sees a split code point or a
// split ANSI sequence.

/** Hard ceiling on retained terminal scrollback (UTF-8 bytes) to bound memory + persist cost. */
export const DEFAULT_HISTORY_BYTE_LIMIT = 1_048_576; // 1 MB

export interface HistoryLimits {
  maxLines: number;
  maxBytes: number;
}

export function countCharacter(value: string, target: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === target) {
      count += 1;
    }
  }
  return count;
}

/** Trim to the last `maxLines` lines, preserving a trailing newline if present. */
export function capHistoryLines(history: string, maxLines: number): string {
  if (history.length === 0) return history;
  const hasTrailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  if (lines.length <= maxLines) return history;
  const capped = lines.slice(lines.length - maxLines).join("\n");
  return hasTrailingNewline ? `${capped}\n` : capped;
}

/**
 * Trim from the front so the retained history is at most ~`maxBytes` UTF-8 bytes.
 *
 * The cut lands on a replay-safe boundary: preferentially the start of an ANSI
 * escape sequence (ESC, 0x1b) or immediately after a newline (0x0a), otherwise
 * the next valid UTF-8 lead byte. Cutting at an ESC means the retained text
 * begins with a complete sequence, so we never split a multi-byte code point or
 * an SGR/CSI/OSC sequence that xterm will replay. `scanWindow` bounds how far we
 * look for a preferred boundary before falling back to a code-point boundary.
 */
export function capHistoryBytes(history: string, maxBytes: number, scanWindow = 65_536): string {
  if (history.length === 0) return history;
  if (maxBytes <= 0) return "";

  const buf = Buffer.from(history, "utf8");
  if (buf.length <= maxBytes) return history;

  const cut = buf.length - maxBytes;
  const scanLimit = Math.min(buf.length, cut + scanWindow);
  let boundary = -1;
  for (let index = cut; index < scanLimit; index += 1) {
    const byte = buf[index];
    if (byte === 0x1b) {
      // ESC: start of a complete escape sequence — safest place to resume.
      boundary = index;
      break;
    }
    if (byte === 0x0a) {
      // Just after a newline — a clean line boundary.
      boundary = index + 1;
      break;
    }
  }
  if (boundary === -1) {
    boundary = cut;
    // Skip UTF-8 continuation bytes (0b10xxxxxx) to land on a code-point start.
    while (boundary < buf.length) {
      const byte = buf[boundary];
      if (byte === undefined || (byte & 0xc0) !== 0x80) break;
      boundary += 1;
    }
  }
  return buf.subarray(boundary).toString("utf8");
}

/** Apply the byte ceiling first (bounds size), then the line cap. */
export function capHistoryByLimits(history: string, limits: HistoryLimits): string {
  return capHistoryLines(capHistoryBytes(history, limits.maxBytes), limits.maxLines);
}
