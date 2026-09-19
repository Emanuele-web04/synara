import { describe, expect, it } from "vitest";

import { ByteAccumulator } from "./byteAccumulator";

describe("ByteAccumulator", () => {
  it("takes bytes across chunk boundaries and keeps the remainder", () => {
    const accumulator = new ByteAccumulator();
    accumulator.append(Uint8Array.of(1, 2));
    accumulator.append(Uint8Array.of(3, 4, 5));
    expect(accumulator.byteLength).toBe(5);

    expect(Array.from(accumulator.take(3))).toEqual([1, 2, 3]);
    expect(accumulator.byteLength).toBe(2);
    expect(Array.from(accumulator.take(2))).toEqual([4, 5]);
    expect(accumulator.byteLength).toBe(0);
  });

  it("copies on append, so a caller reusing its buffer cannot rewrite pending bytes", () => {
    const accumulator = new ByteAccumulator();
    const chunk = Buffer.from([7, 7, 7]);
    accumulator.append(chunk);
    const taken = accumulator.take(3);
    chunk.fill(0);

    expect(Array.from(taken)).toEqual([7, 7, 7]);
  });

  it("reads a u32 that straddles chunks and skips without materializing", () => {
    const accumulator = new ByteAccumulator();
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(0xdead_beef, 0);
    accumulator.append(prefix.subarray(0, 1));
    accumulator.append(prefix.subarray(1));
    accumulator.append(Uint8Array.of(9));

    expect(accumulator.readUInt32LE(0)).toBe(0xdead_beef);
    accumulator.skip(4);
    expect(Array.from(accumulator.take(1))).toEqual([9]);
  });

  it("refuses reads past the bytes it holds", () => {
    const accumulator = new ByteAccumulator();
    accumulator.append(Uint8Array.of(1, 2, 3));

    expect(() => accumulator.readUInt32LE(0)).toThrow(RangeError);
    expect(() => accumulator.take(4)).toThrow(RangeError);
    expect(() => accumulator.skip(4)).toThrow(RangeError);
    accumulator.clear();
    expect(accumulator.byteLength).toBe(0);
  });
});
