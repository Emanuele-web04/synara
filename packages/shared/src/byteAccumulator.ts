/**
 * Front-consuming byte queue for stream parsers.
 *
 * A pipe or socket delivers arbitrary chunks, so every parser over one has to
 * hold a partial record until the rest arrives. Re-concatenating the pending
 * bytes on each chunk is quadratic in the size of a record: an 8 MB record
 * arriving in 64 KB chunks copies about half a gigabyte to deliver eight.
 * Chunks are retained as they arrive and joined exactly once, when a whole
 * record is taken.
 *
 * Both record splitters in this package — length-prefixed and newline-delimited
 * — accumulate through this, so the buffering strategy exists once.
 */

const EMPTY = Buffer.alloc(0);

export class ByteAccumulator {
  private readonly chunks: Buffer[] = [];
  private length = 0;

  get byteLength(): number {
    return this.length;
  }

  /**
   * Appends a chunk, copying it.
   *
   * The copy is not optional: callers hand over views into buffers they keep
   * writing to, and the bytes have to survive until the record completes.
   */
  append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.chunks.push(Buffer.from(chunk));
    this.length += chunk.byteLength;
  }

  /** A little-endian u32 read in place, without joining the pending chunks. */
  readUInt32LE(offset: number): number {
    if (offset < 0 || offset + 4 > this.length) {
      throw new RangeError("Byte accumulator u32 read is out of range");
    }
    const first = this.chunks[0];
    if (first && first.byteLength >= offset + 4) return first.readUInt32LE(offset);
    return (
      (this.byteAt(offset) |
        (this.byteAt(offset + 1) << 8) |
        (this.byteAt(offset + 2) << 16) |
        (this.byteAt(offset + 3) << 24)) >>>
      0
    );
  }

  /**
   * Removes the first `byteLength` bytes and returns them as one buffer.
   *
   * The result is backed by memory this accumulator owns, so it stays valid
   * after later appends.
   */
  take(byteLength: number): Buffer {
    if (byteLength < 0 || byteLength > this.length) {
      throw new RangeError("Byte accumulator take is out of range");
    }
    if (byteLength === 0) return EMPTY;

    const first = this.chunks[0];
    if (first && first.byteLength >= byteLength) {
      const taken = first.subarray(0, byteLength);
      if (first.byteLength === byteLength) this.chunks.shift();
      else this.chunks[0] = first.subarray(byteLength);
      this.length -= byteLength;
      return taken;
    }

    const parts: Buffer[] = [];
    let remaining = byteLength;
    while (remaining > 0) {
      const chunk = this.chunks[0];
      if (!chunk) break;
      if (chunk.byteLength <= remaining) {
        parts.push(chunk);
        this.chunks.shift();
        remaining -= chunk.byteLength;
      } else {
        parts.push(chunk.subarray(0, remaining));
        this.chunks[0] = chunk.subarray(remaining);
        remaining = 0;
      }
    }
    this.length -= byteLength;
    return Buffer.concat(parts, byteLength);
  }

  /** Removes the first `byteLength` bytes without materializing them. */
  skip(byteLength: number): void {
    if (byteLength < 0 || byteLength > this.length) {
      throw new RangeError("Byte accumulator skip is out of range");
    }
    let remaining = byteLength;
    while (remaining > 0) {
      const chunk = this.chunks[0];
      if (!chunk) break;
      if (chunk.byteLength <= remaining) {
        this.chunks.shift();
        remaining -= chunk.byteLength;
      } else {
        this.chunks[0] = chunk.subarray(remaining);
        remaining = 0;
      }
    }
    this.length -= byteLength;
  }

  clear(): void {
    this.chunks.length = 0;
    this.length = 0;
  }

  private byteAt(index: number): number {
    let offset = index;
    for (const chunk of this.chunks) {
      if (offset < chunk.byteLength) return chunk[offset] as number;
      offset -= chunk.byteLength;
    }
    throw new RangeError("Byte accumulator index is out of range");
  }
}
