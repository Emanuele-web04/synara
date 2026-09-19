import { describe, expect, it } from "vitest";

import {
  decodeFrameEnvelope,
  encodeFrameEnvelope,
  FrameEncodeError,
  FRAME_HEADER_FIXED_BYTES,
} from "./frameEnvelope";
import {
  DEVICE_FRAME_HEADER_FIXED_BYTES,
  DEVICE_FRAME_MAGIC,
  DEVICE_FRAME_MAX_DEVICE_ID_BYTES,
  DEVICE_FRAME_VERSION,
} from "@synara/contracts";

describe("shared frame envelope codec", () => {
  const deviceCodec = {
    magic: DEVICE_FRAME_MAGIC,
    version: DEVICE_FRAME_VERSION,
    streamIdLabel: "deviceId",
    frameLabel: "Device",
    maxStreamIdBytes: DEVICE_FRAME_MAX_DEVICE_ID_BYTES,
  } as const;

  it("keeps the fixed header layout and round-trips the real codec", () => {
    expect(FRAME_HEADER_FIXED_BYTES).toBe(DEVICE_FRAME_HEADER_FIXED_BYTES);

    const encoded = encodeFrameEnvelope(deviceCodec, {
      header: {
        streamId: "d",
        sequence: 0x0102_0304,
        timestampMs: 1.5,
        keyframe: true,
        codecConfig: true,
      },
      payload: Uint8Array.of(0xaa, 0xbb),
    });

    expect(Array.from(encoded.subarray(0, FRAME_HEADER_FIXED_BYTES))).toEqual([
      0x46, 0x53, 0x01, 0x03, 0x04, 0x03, 0x02, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8,
      0x3f, 0x01,
    ]);
    expect(decodeFrameEnvelope(deviceCodec, encoded)).toEqual({
      ok: true,
      frame: {
        header: {
          streamId: "d",
          sequence: 0x0102_0304,
          timestampMs: 1.5,
          keyframe: true,
          codecConfig: true,
        },
        payload: Uint8Array.of(0xaa, 0xbb),
      },
    });
  });

  it("rejects invalid stream ids, magic, and versions", () => {
    const frame = {
      header: {
        streamId: "d",
        sequence: 1,
        timestampMs: 0,
        keyframe: false,
        codecConfig: false,
      },
      payload: new Uint8Array(),
    } as const;

    expect(() =>
      encodeFrameEnvelope(deviceCodec, { ...frame, header: { ...frame.header, streamId: "" } }),
    ).toThrow(FrameEncodeError);
    expect(() =>
      encodeFrameEnvelope(deviceCodec, {
        ...frame,
        header: { ...frame.header, streamId: "x".repeat(DEVICE_FRAME_MAX_DEVICE_ID_BYTES + 1) },
      }),
    ).toThrow(FrameEncodeError);

    const encoded = encodeFrameEnvelope(deviceCodec, frame);
    const wrongMagic = encoded.slice();
    new DataView(wrongMagic.buffer, wrongMagic.byteOffset, wrongMagic.byteLength).setUint16(
      0,
      DEVICE_FRAME_MAGIC ^ 0xffff,
      true,
    );
    expect(decodeFrameEnvelope(deviceCodec, wrongMagic)).toEqual({
      ok: false,
      reason: "bad-magic",
    });

    const unsupportedVersion = encoded.slice();
    unsupportedVersion[2] = DEVICE_FRAME_VERSION + 1;
    expect(decodeFrameEnvelope(deviceCodec, unsupportedVersion)).toEqual({
      ok: false,
      reason: "unsupported-version",
    });
  });
});
