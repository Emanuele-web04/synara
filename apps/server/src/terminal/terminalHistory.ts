// scrollback caps: a redrawing TUI repaints via cursor moves with almost no newlines, so a line-only cap is unbounded — also enforce a UTF-8 byte ceiling, trimmed only on replay-safe boundaries

/** hard ceiling on retained scrollback to bound memory + persist cost */
export const DEFAULT_HISTORY_BYTE_LIMIT = 1_048_576;

export interface HistoryLimits {
  maxLines: number;
  maxBytes: number;
}

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

/** cut lands on a replay-safe boundary (ESC or post-newline, else the next UTF-8 lead byte) so replay never sees a split sequence */
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
      // ESC: safest place to resume
      boundary = index;
      break;
    }
    if (byte === 0x0a) {
      // just after a newline: a clean line boundary
      boundary = index + 1;
      break;
    }
  }
  if (boundary === -1) {
    boundary = cut;
    // skip UTF-8 continuation bytes to land on a code-point start
    while (boundary < buf.length) {
      const byte = buf[boundary];
      if (byte === undefined || (byte & 0xc0) !== 0x80) break;
      boundary += 1;
    }
  }
  return buf.subarray(boundary).toString("utf8");
}

/** byte ceiling first (bounds size), then the line cap */
export function capHistoryByLimits(history: string, limits: HistoryLimits): string {
  return capHistoryLines(capHistoryBytes(history, limits.maxBytes), limits.maxLines);
}

/** append-optimized: eager capping is O(history) per chunk; instead drop whole front chunks lazily and cap precisely in toString() — equivalent since capping only trims the front */
export class TerminalHistoryBuffer {
  private chunks: Array<{ text: string; bytes: number }> = [];
  private totalBytes = 0;
  /** null when chunks changed since the last read */
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

  /** drop whole front chunks while remaining bytes still cover the ceiling — bounds to ~maxBytes + lastChunkSize */
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
    // compact so repeated reads are O(1) and footprint matches observable history
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
