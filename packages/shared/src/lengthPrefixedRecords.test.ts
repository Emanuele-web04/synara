import { describe, expect, it } from "vitest";

import {
  encodeLengthPrefixedRecord,
  LengthPrefixedRecordError,
  LengthPrefixedRecordParser,
} from "./lengthPrefixedRecords";

const payload = (...values: number[]): Uint8Array => Uint8Array.from(values);
const bytes = (value: Uint8Array): readonly number[] => Array.from(value);

describe("LengthPrefixedRecordParser", () => {
  it("yields every whole record in one chunk", () => {
    const parser = new LengthPrefixedRecordParser();
    const chunk = Buffer.concat([
      encodeLengthPrefixedRecord(payload(1, 2, 3)),
      encodeLengthPrefixedRecord(payload(4)),
    ]);

    expect(parser.push(chunk).map(bytes)).toEqual([[1, 2, 3], [4]]);
  });

  it("reassembles a record split across chunks", () => {
    // A pipe delivers whatever size it likes, so the split can fall anywhere —
    // including inside the length prefix itself.
    const parser = new LengthPrefixedRecordParser();
    const record = encodeLengthPrefixedRecord(payload(9, 8, 7, 6));

    for (const cut of [1, 3, 5]) {
      expect(parser.push(record.subarray(0, cut))).toEqual([]);
      expect(parser.push(record.subarray(cut)).map(bytes)).toEqual([[9, 8, 7, 6]]);
    }
  });

  it("holds a trailing partial record until the rest arrives", () => {
    const parser = new LengthPrefixedRecordParser();
    const whole = encodeLengthPrefixedRecord(payload(1, 1));
    const partial = encodeLengthPrefixedRecord(payload(2, 2));

    expect(parser.push(Buffer.concat([whole, partial.subarray(0, 5)])).map(bytes)).toEqual([
      [1, 1],
    ]);
    expect(parser.push(partial.subarray(5)).map(bytes)).toEqual([[2, 2]]);
  });

  it("passes a zero-length record through as an empty payload", () => {
    const parser = new LengthPrefixedRecordParser();

    expect(parser.push(encodeLengthPrefixedRecord(payload())).map(bytes)).toEqual([[]]);
  });

  it("copies the payload, so a later chunk cannot rewrite a record already handed out", () => {
    const parser = new LengthPrefixedRecordParser();
    const record = encodeLengthPrefixedRecord(payload(5, 5));

    const first = parser.push(record)[0];
    record.fill(0);

    expect(first && bytes(first)).toEqual([5, 5]);
  });

  it("reassembles a record delivered in many small chunks", () => {
    // The parser used to re-concatenate everything pending on each chunk, which
    // is quadratic: this record alone copied hundreds of megabytes to deliver
    // eight. Correctness is what is asserted here; the cost is why it changed.
    const parser = new LengthPrefixedRecordParser();
    const body = Buffer.alloc(8 * 1024 * 1024);
    for (let offset = 0; offset < body.byteLength; offset += 4096) {
      body.writeUInt32LE(offset >>> 2, offset);
    }
    const record = encodeLengthPrefixedRecord(body);

    let delivered: readonly Uint8Array[] = [];
    for (let offset = 0; offset < record.byteLength; offset += 64 * 1024) {
      const chunk = record.subarray(offset, Math.min(offset + 64 * 1024, record.byteLength));
      const payloads = parser.push(chunk);
      if (payloads.length > 0) delivered = payloads;
    }

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.byteLength).toBe(body.byteLength);
    expect(Buffer.from(delivered[0] ?? new Uint8Array()).equals(body)).toBe(true);
  });

  it("throws on a record past the limit rather than trying to resynchronize", () => {
    // The length that would find the next record is read from the same bytes
    // that are already wrong, so there is nothing to skip forward to: the
    // caller has to drop the connection.
    const parser = new LengthPrefixedRecordParser(16);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(64, 0);

    expect(() => parser.push(oversized)).toThrow(LengthPrefixedRecordError);
    try {
      parser.push(oversized);
    } catch (error) {
      expect(error).toMatchObject({ declaredBytes: 64, maxBytes: 16 });
    }
  });
});
