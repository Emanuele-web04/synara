/**
 * Front-consuming byte queue for stream parsers.
 *
 * A pipe or socket delivers arbitrary chunks, so a parser has to hold a partial
 * record until the rest arrives. Re-concatenating the pending bytes on every
 * chunk is quadratic in the record size: an 8 MB record arriving in 64 KB
 * chunks copies about half a gigabyte to deliver eight. Chunks are kept as
 * they arrive and joined once, when a whole record is taken.
 *
 * The newline framer in `./jsonrpc-stdio` and the length-prefixed splitter in
 * `./lengthPrefixedRecords` both buffer through this.
 */

export class ByteAccumulator {
  private readonly chunks: Buffer[] = [];
  private length = 0;

  get byteLength(): number {
    return this.length;
  }

  /**
   * Appends a copy of `chunk`. Callers may hand over views into buffers they
   * keep writing to, and the bytes have to survive until the record completes.
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
   * Removes the first `byteLength` bytes and returns them as one buffer. The
   * result is backed by memory this accumulator owns and never writes again, so
   * it stays valid after later appends.
   */
  take(byteLength: number): Buffer {
    const first = this.chunks[0];
    if (first && first.byteLength >= byteLength) {
      this.skip(byteLength);
      return first.subarray(0, byteLength);
    }
    this.checkRange(byteLength);
    const taken = Buffer.concat(this.chunks, byteLength);
    this.skip(byteLength);
    return taken;
  }

  /** Removes the first `byteLength` bytes without joining them. */
  skip(byteLength: number): void {
    this.checkRange(byteLength);
    let remaining = byteLength;
    while (remaining > 0) {
      const chunk = this.chunks[0]!;
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

  private checkRange(byteLength: number): void {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > this.length) {
      throw new RangeError("Byte accumulator range is out of bounds");
    }
  }

  private byteAt(index: number): number {
    let offset = index;
    for (const chunk of this.chunks) {
      if (offset < chunk.byteLength) return chunk[offset]!;
      offset -= chunk.byteLength;
    }
    throw new RangeError("Byte accumulator index is out of range");
  }
}
