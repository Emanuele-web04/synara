import { describe, expect, it } from "vitest";

import { ByteAccumulator } from "./byteAccumulator";

const bytes = (value: Uint8Array): readonly number[] => Array.from(value);

describe("ByteAccumulator", () => {
  it("takes a prefix that spans several chunks and keeps the remainder", () => {
    const accumulator = new ByteAccumulator();
    accumulator.append(Uint8Array.of(1, 2));
    accumulator.append(Uint8Array.of(3, 4, 5));
    accumulator.append(Uint8Array.of(6));

    expect(bytes(accumulator.take(4))).toEqual([1, 2, 3, 4]);
    expect(accumulator.byteLength).toBe(2);
    expect(bytes(accumulator.take(2))).toEqual([5, 6]);
    expect(accumulator.byteLength).toBe(0);
  });

  it("reads a u32 whose bytes straddle chunk boundaries", () => {
    const accumulator = new ByteAccumulator();
    const value = Buffer.alloc(4);
    value.writeUInt32LE(0xfedc_ba98, 0);
    accumulator.append(value.subarray(0, 1));
    accumulator.append(value.subarray(1, 3));
    accumulator.append(value.subarray(3));

    expect(accumulator.readUInt32LE(0)).toBe(0xfedc_ba98);
    expect(accumulator.byteLength).toBe(4);
  });

  it("skips without disturbing the bytes after the skipped range", () => {
    const accumulator = new ByteAccumulator();
    accumulator.append(Uint8Array.of(1, 2, 3));
    accumulator.append(Uint8Array.of(4, 5));
    accumulator.skip(4);

    expect(bytes(accumulator.take(1))).toEqual([5]);
  });

  it("copies appended chunks so the caller can reuse its buffer", () => {
    const accumulator = new ByteAccumulator();
    const scratch = Uint8Array.of(9, 9);
    accumulator.append(scratch);
    scratch.fill(0);

    expect(bytes(accumulator.take(2))).toEqual([9, 9]);
  });

  it("takes stable owned buffers without copying and keeps returned views valid", () => {
    const accumulator = new ByteAccumulator();
    const source = Buffer.from([1, 2, 3]);
    accumulator.appendOwned(Buffer.alloc(0));
    accumulator.appendOwned(source);
    const prefix = accumulator.take(2);
    expect(prefix.buffer).toBe(source.buffer);
    expect(prefix.byteOffset).toBe(source.byteOffset);

    accumulator.appendOwned(Buffer.from([4, 5]));
    expect(bytes(accumulator.take(3))).toEqual([3, 4, 5]);
    accumulator.appendOwned(Buffer.from([6]));
    accumulator.clear();
    expect(accumulator.byteLength).toBe(0);
    expect(bytes(prefix)).toEqual([1, 2]);
  });

  it("rejects reads past the buffered bytes", () => {
    const accumulator = new ByteAccumulator();
    accumulator.append(Uint8Array.of(1, 2, 3));

    expect(() => accumulator.readUInt32LE(0)).toThrow(RangeError);
    expect(() => accumulator.take(4)).toThrow(RangeError);
    expect(() => accumulator.skip(-1)).toThrow(RangeError);
    expect(accumulator.byteLength).toBe(3);
  });
});
