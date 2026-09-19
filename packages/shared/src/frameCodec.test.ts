import { describe, expect, it } from "vitest";

import { makeFrameCodec } from "./frameCodec";

class TestFrameEncodeError extends Error {}

const codec = makeFrameCodec({
  magic: 0x5454,
  version: 1,
  streamIdKey: "streamName",
  frameLabel: "Test",
  maxStreamIdBytes: 8,
  decodeReasons: { truncatedStreamId: "truncated-name", invalidStreamId: "invalid-name" },
  encodeError: TestFrameEncodeError,
});

describe("makeFrameCodec", () => {
  const header = {
    streamName: "abc",
    sequence: 7,
    timestampMs: 1234.5,
    keyframe: true,
    codecConfig: false,
  };

  it("round-trips a frame with the family's own stream id key", () => {
    const payload = Uint8Array.of(1, 2, 3);
    const decoded = codec.decode(codec.encode({ header, payload }));
    expect(decoded).toEqual({ ok: true, frame: { header, payload } });
  });

  it("raises the family's encode error for a bad stream id", () => {
    expect(() =>
      codec.encode({ header: { ...header, streamName: "" }, payload: new Uint8Array() }),
    ).toThrow(TestFrameEncodeError);
    expect(() =>
      codec.encode({
        header: { ...header, streamName: "far-too-long" },
        payload: new Uint8Array(),
      }),
    ).toThrow(TestFrameEncodeError);
  });

  it("names stream-id decode failures in the family's vocabulary", () => {
    const bytes = codec.encode({ header, payload: Uint8Array.of(9) });
    expect(codec.decode(bytes.slice(0, 18))).toEqual({ ok: false, reason: "truncated-name" });
    const other = makeFrameCodec({
      magic: 0x5455,
      version: 1,
      streamIdKey: "streamName",
      frameLabel: "Other",
      maxStreamIdBytes: 8,
      decodeReasons: { truncatedStreamId: "truncated-name", invalidStreamId: "invalid-name" },
      encodeError: TestFrameEncodeError,
    });
    expect(other.decode(bytes)).toEqual({ ok: false, reason: "bad-magic" });
    expect(codec.decode(new Uint8Array(3))).toEqual({ ok: false, reason: "too-short" });
  });
});
