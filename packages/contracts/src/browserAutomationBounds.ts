import { Schema } from "effect";

const utf8Encoder = new TextEncoder();

export const utf8ByteLength = (value: string): number => utf8Encoder.encode(value).byteLength;

export const BoundedUtf8String = (maxBytes: number, minBytes = 0) => {
  if (
    !Number.isSafeInteger(maxBytes) ||
    !Number.isSafeInteger(minBytes) ||
    minBytes < 0 ||
    maxBytes < minBytes
  ) {
    throw new RangeError("UTF-8 byte bounds must be non-negative safe integers with min <= max");
  }

  return Schema.String.check(
    Schema.makeFilter((value: string) => {
      const byteLength = utf8ByteLength(value);
      return byteLength >= minBytes && byteLength <= maxBytes;
    }),
  );
};
