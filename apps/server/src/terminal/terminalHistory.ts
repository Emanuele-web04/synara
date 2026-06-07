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

/**
 * Append-optimized scrollback buffer.
 *
 * Terminal history is appended on the hot output path but read rarely (persist
 * debounce, reconnect snapshot). Capping eagerly on every append re-scans the
 * whole retained buffer — O(history) per chunk — which throttles streaming
 * output once scrollback fills. Instead we keep raw chunks and only drop whole
 * chunks from the front once they fall entirely outside the byte ceiling, so
 * `append()` is O(chunk). The precise replay-safe cap (`capHistoryByLimits`)
 * runs lazily in `toString()`.
 *
 * Capping only ever trims from the front and retains at most `maxBytes` bytes,
 * so capping once over the retained window is identical to capping incrementally
 * on every append: the eviction window always covers the last `maxBytes` bytes,
 * which is the only region `capHistoryByLimits` can keep. `toString()` therefore
 * produces exactly the string eager per-chunk capping would have.
 */
export class TerminalHistoryBuffer {
  private chunks: Array<{ text: string; bytes: number }> = [];
  private totalBytes = 0;
  /** Cached materialized (capped) form; null when chunks changed since last read. */
  private cached: string | null = "";

  constructor(private readonly limits: HistoryLimits) {}

  static fromString(text: string, limits: HistoryLimits): TerminalHistoryBuffer {
    const buffer = new TerminalHistoryBuffer(limits);
    buffer.append(text);
    return buffer;
  }

  get isEmpty(): boolean {
    return this.totalBytes === 0;
  }

  append(chunk: string): void {
    if (chunk.length === 0) return;
    const bytes = Buffer.byteLength(chunk, "utf8");
    this.chunks.push({ text: chunk, bytes });
    this.totalBytes += bytes;
    this.cached = null;
    this.evictFront();
  }

  reset(): void {
    this.chunks = [];
    this.totalBytes = 0;
    this.cached = "";
  }

  /**
   * Drop whole front chunks while the remaining bytes still cover the byte
   * ceiling. `capHistoryByLimits` never retains anything before `length -
   * maxBytes`, so any chunk fully outside that window is safe to discard. Keeps
   * the buffer bounded to roughly `maxBytes + lastChunkSize`.
   */
  private evictFront(): void {
    const { maxBytes } = this.limits;
    while (this.chunks.length > 1) {
      const front = this.chunks[0];
      if (front === undefined) break;
      if (this.totalBytes - front.bytes < maxBytes) break;
      this.chunks.shift();
      this.totalBytes -= front.bytes;
    }
  }

  toString(): string {
    if (this.cached !== null) return this.cached;
    const joined =
      this.chunks.length === 1
        ? (this.chunks[0]?.text ?? "")
        : this.chunks.map((chunk) => chunk.text).join("");
    const capped = capHistoryByLimits(joined, this.limits);
    // Compact to the capped form so repeated reads are O(1) and the retained
    // footprint matches the observable history exactly.
    if (capped.length > 0) {
      this.chunks = [{ text: capped, bytes: Buffer.byteLength(capped, "utf8") }];
      this.totalBytes = this.chunks[0]?.bytes ?? 0;
    } else {
      this.chunks = [];
      this.totalBytes = 0;
    }
    this.cached = capped;
    return capped;
  }
}
